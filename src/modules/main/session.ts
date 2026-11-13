import { stateSchema, transition, type Command, type GameState } from '../../domain/game';

/**
 * A player's game data on the game server: progress, HP, XP, battles. What
 * they own (coins, creatures) is a projection of what their DSM wallet proved
 * it owns; this state never issues or spends it.
 */
export class GameSession {
  private state: GameState;
  constructor(holder: string, snapshot: string) {
    this.state = stateSchema.parse(JSON.parse(snapshot));
    if (this.state.holder !== holder) throw new Error('Snapshot holder mismatch');
  }
  read(): GameState { return structuredClone(this.state); }
  execute(command: Command, expected: number, id: string): GameState {
    this.state = transition(this.state, expected, id, command);
    return this.read();
  }
  snapshot(): string { return JSON.stringify(this.state); }
}
