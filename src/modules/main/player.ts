import { type RpgPlayerHooks } from '@rpgjs/server';
import { openJourney, session } from './journey';
import { fieldHud, checkEncounter, commit, setFighting, setInArena } from './field';
import { activateAvatar, isCurrentAvatar, releaseAvatar } from './presence';
import { connectWallet, leave, openPanel, resumeWallet, watchWallet } from './dsm';
import { leaveLobby, rejoin } from './lobby';

/** The player's walking pace; NPCs patrol at 1. */
const PLAYER_SPEED = 1.8;

export const player: RpgPlayerHooks = {
  props: { creatureSave: String },
  async onConnected(player) {
    player.speed = PLAYER_SPEED; // NPC patrol speed stays at 1.
    player.setHitbox(16, 16); // Footprint leaves eight pixels of clearance on each side of the gate.
    player.throughEvent = false; // Characters remain solid; NPC routes avoid the main path.
    player.name = player.t('game.name'); player.graphics.set([]);
    player.through = true; // A connection waiting for a wallet has no map avatar.
    // Centre the smaller footprint on the map start at (368,176).
    await player.changeMap('simplemap', { x: 360, y: 168 });
  },
  onJoinMap(player) {
    player.animationFixed = false;
    player.directionFixed = false;
    player.breakRoutes(true);
    player.speed = PLAYER_SPEED; // Reapply after a reconnect restores the player snapshot.
    player.setHitbox(16, 16);
    player.graphics.set([]);
    player.through = true;
    // The engine retains disconnected sessions for reconnection. Hide their avatars.
    for (const other of player.getCurrentMap()?.getPlayers() ?? []) {
      if (other.id !== player.id && (!other.isConnected() || !other.creatureSave())) {
        other.graphics.set([]);
        other.through = true;
      }
    }
    // The player's wallet first: its account keys the game profile.
    openPanel(player);
    const connect = (reason = '') => connectWallet(player, (state) => {
      if (!player.isConnected()) return;
      player.creatureSave.set(JSON.stringify(state));
      activateAvatar(player, state.holder);
      fieldHud(player);
      void rejoin(player);
    }, reason).catch((e) => {
      player.gui('dsm-connect').update({ code: '', status: `Connecting failed: ${e instanceof Error ? e.message : String(e)}` });
    });
    // No wallet, no game: a wallet that ends its session with the game (from its own Apps screen)
    // sends the page back to the connect screen, whatever it was doing.
    const disconnected = () => {
      if (!player.isConnected()) return;
      for (const id of ['dsm-market', 'bramble-shop', 'lobby', 'creature-battle', 'mission-board', 'portrait-dialogue', 'field-hud']) player.getGui(id)?.close();
      leaveLobby(player);
      setFighting(player, false);
      setInArena(player, false);
      void connect('Your wallet disconnected from the game.');
    };
    watchWallet(player, disconnected);
    if (player.creatureSave()) {
      // The page came back with its game loaded (from the wallet app, or after a dropped
      // connection). Its wallet session comes back from the game's account before anything asks
      // the wallet for something; only a wallet with no session left connects afresh.
      const holder: string = JSON.parse(player.creatureSave()).holder;
      activateAvatar(player, holder);
      fieldHud(player);
      resumeWallet(player, holder)
        .then((resumed) => {
          if (!player.isConnected()) return;
          // A wallet that ended its session while the page was away (on the phone, in the wallet
          // app) is told like one that ends it while the page is open.
          if (resumed === 'resumed') void rejoin(player); else if (resumed === 'disconnected') disconnected(); else void connect();
        })
        .catch(() => { if (player.isConnected()) void connect(); });
      return;
    }
    void connect();
  },
  // The map's characters run this hook too; only a player has a game save to check.
  async onMove(player) { if (typeof player.creatureSave === 'function' && isCurrentAvatar(player)) await checkEncounter(player); },
  async onInput(player, { action }) {
    if (!isCurrentAvatar(player) || !player.creatureSave()) return;
    if (action === 'escape' && session(player).read().battle?.outcome !== 'active') { await openJourney(player, commit); fieldHud(player); }
  },
  onDisconnected(player) {
    leaveLobby(player);
    releaseAvatar(player);
    player.breakRoutes(true);
    player.graphics.set([]);
    player.through = true;
    leave(player);
  },
};
