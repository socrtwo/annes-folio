/** Registers every command module. */
import './file';
import './edit';
import './view';
import './home';
import './nav';
import.meta.glob(['./*.ts', '!./index.ts', '!./registry.ts', '!./util.ts', '!./ocrlayer.ts'], { eager: true });
export { def, getCommand, allCommands, commandCount, searchCommands } from './registry';
