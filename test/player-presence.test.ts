import { beforeEach, expect, it, vi } from 'vitest';
const wallet=vi.hoisted(()=>({bind:undefined as undefined|((state:any)=>void),resumes:'resumed' as 'resumed'|'disconnected'|'none'}));
vi.mock('../src/modules/main/dsm',()=>({connectWallet:vi.fn(async(_p:any,b:any)=>{wallet.bind=b;}),leave:vi.fn(),openPanel:vi.fn(),resumeWallet:vi.fn(async()=>wallet.resumes),watchWallet:vi.fn()}));
vi.mock('../src/modules/main/field',()=>({fieldHud:vi.fn(),checkEncounter:vi.fn(),commit:vi.fn(),setFighting:vi.fn(),setInArena:vi.fn()}));
vi.mock('../src/modules/main/journey',()=>({openJourney:vi.fn(),session:vi.fn()}));
vi.mock('../src/modules/main/lobby',()=>({leaveLobby:vi.fn(),rejoin:vi.fn(async()=>{})}));
import { reconcileAvatars } from '../src/modules/main/presence';
import { player } from '../src/modules/main/player';
function fixture(){let save='',connected=true;const creatureSave:any=()=>save;creatureSave.set=(v:string)=>{save=v;};return {id:'current',t:()=>'',name:'',through:false,throughEvent:false,_graphicScale:Object.assign(()=>1,{set:vi.fn()}),graphics:Object.assign(()=>['hero'],{set:vi.fn()}),setGraphic:vi.fn(),setHitbox:vi.fn(),getGui:()=>undefined,breakRoutes:vi.fn(),changeMap:vi.fn(async()=>{}),getCurrentMap:()=>({getPlayers:()=>[]}),creatureSave,isConnected:()=>connected,disconnect:()=>{connected=false;}} as any;}
beforeEach(()=>{wallet.bind=undefined;wallet.resumes='resumed';});
it('shows one avatar only after wallet connection, and clears it on disconnect',async()=>{
 const p=fixture();await player.onConnected!(p);player.onJoinMap!(p,p.getCurrentMap());
 expect(p.setGraphic).not.toHaveBeenCalled();expect(p.through).toBe(true);
 wallet.bind!({revision:0});expect(p.setGraphic).toHaveBeenCalledExactlyOnceWith('hero');expect(p.through).toBe(false);
 p.disconnect();player.onDisconnected!(p);expect(p.graphics.set).toHaveBeenLastCalledWith([]);expect(p.breakRoutes).toHaveBeenCalled();
});
it('does not resurrect a disconnected avatar when a wallet callback arrives late',()=>{
 const p=fixture();player.onJoinMap!(p,p.getCurrentMap());p.disconnect();wallet.bind!({revision:0});expect(p.setGraphic).not.toHaveBeenCalled();
});

it('uses a compact footprint with clearance in the one-tile gateway',async()=>{
 const p=fixture();await player.onConnected!(p);
 expect(p.setHitbox).toHaveBeenCalledWith(16,16);
 expect(p.changeMap).toHaveBeenCalledWith('simplemap',{x:360,y:168});
});

it('replaces an overlapping live avatar for the same wallet without hiding another wallet',()=>{
 const old=fixture(), current=fixture(), stranger=fixture();
 old.id='old';stranger.id='stranger';
 old.creatureSave.set(JSON.stringify({holder:'same-wallet'}));
 stranger.creatureSave.set(JSON.stringify({holder:'other-wallet'}));
 current.getCurrentMap=()=>({getPlayers:()=>[old,current,stranger]});
 player.onJoinMap!(current,current.getCurrentMap());wallet.bind!({holder:'same-wallet',revision:0});
 expect(old.graphics.set).toHaveBeenLastCalledWith([]);
 expect(old._graphicScale.set).toHaveBeenLastCalledWith(0);expect(current._graphicScale.set).toHaveBeenLastCalledWith(1);expect(old.through).toBe(true);expect(old.canMove).toBe(false);expect(old.breakRoutes).toHaveBeenCalled();
 expect(current.setGraphic).toHaveBeenCalledExactlyOnceWith('hero');expect(current.canMove).toBe(true);
 expect(stranger.graphics.set).not.toHaveBeenCalled();
 // A late disconnect for the old page must not hide the current character.
 player.onDisconnected!(old);expect(current.graphics.set).toHaveBeenCalledTimes(1);
});
it('uses the responsive player walking speed',async()=>{const p=fixture();await player.onConnected!(p);expect(p.speed).toBe(1.8);});

it('restores the player walking pace when rejoining with an old snapshot',()=>{
 const p=fixture();p.speed=4;player.onJoinMap!(p,p.getCurrentMap());expect(p.speed).toBe(1.8);
});

it('clears a retained starting avatar after a lost connection without another join',()=>{
 const stale=fixture();stale.creatureSave.set(JSON.stringify({holder:'lost-wallet'}));stale.disconnect();
 reconcileAvatars([stale]);expect(stale.graphics.set).toHaveBeenLastCalledWith([]);
 expect(stale.through).toBe(true);expect(stale.canMove).toBe(false);
});
it('repairs overlapping retained wallet avatars without hiding a different player',()=>{
 const a=fixture(),b=fixture(),other=fixture();a.id='a';b.id='b';other.id='other';
 a.creatureSave.set(JSON.stringify({holder:'retained-wallet'}));b.creatureSave.set(JSON.stringify({holder:'retained-wallet'}));other.creatureSave.set(JSON.stringify({holder:'unrelated-wallet'}));
 reconcileAvatars([a,b,other]);expect(b.graphics.set).toHaveBeenLastCalledWith([]);expect(b.canMove).toBe(false);
 expect(a.graphics.set).not.toHaveBeenCalled();expect(other.graphics.set).not.toHaveBeenCalled();
});
it('clears an old facing/animation lock when reconnecting',()=>{
 const p=fixture();p.directionFixed=true;p.animationFixed=true;player.onJoinMap!(p,p.getCurrentMap());
 expect(p.directionFixed).toBe(false);expect(p.animationFixed).toBe(false);
});

it('picks its wallet session up again when the page comes back with its game loaded',async()=>{
 const p=fixture();p.creatureSave.set(JSON.stringify({holder:'back-wallet'}));
 player.onJoinMap!(p,p.getCurrentMap());await new Promise(r=>setTimeout(r,0));
 const { resumeWallet, connectWallet } = await import('../src/modules/main/dsm');
 expect(resumeWallet).toHaveBeenCalledWith(p,'back-wallet');
 expect(wallet.bind).toBeUndefined();expect(connectWallet).not.toHaveBeenCalledWith(p,expect.anything());
 expect(p.setGraphic).toHaveBeenCalledWith('hero');
});
it('connects afresh when the wallet has no session left to pick up',async()=>{
 wallet.resumes='none';const p=fixture();p.creatureSave.set(JSON.stringify({holder:'gone-wallet'}));
 player.onJoinMap!(p,p.getCurrentMap());await new Promise(r=>setTimeout(r,0));
 expect(wallet.bind).toBeDefined();
});
it('tells a page that comes back that its wallet disconnected while it was away',async()=>{
 wallet.resumes='disconnected';const p=fixture();p.creatureSave.set(JSON.stringify({holder:'ended-wallet'}));
 player.onJoinMap!(p,p.getCurrentMap());await new Promise(r=>setTimeout(r,0));
 const { connectWallet } = await import('../src/modules/main/dsm');
 expect(connectWallet).toHaveBeenLastCalledWith(p,expect.any(Function),'Your wallet disconnected from the game.');
});
it('ignores the map characters that run the move hook without a game save',async()=>{
 const { checkEncounter } = await import('../src/modules/main/field');
 const npc={...fixture(),creatureSave:undefined} as any;
 await player.onMove!(npc);expect(checkEncounter).not.toHaveBeenCalledWith(npc);
 reconcileAvatars([npc]);
});
