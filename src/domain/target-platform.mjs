import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../contracts/ports.mjs';
import { commandLineNames } from './command-line.mjs';
import { windowsCommandLineNames } from './windows-command-line.mjs';

/** Platform selection is administrator-owned and bound by the target revision. */
export const platformOf = target => target?.platform ?? 'linux';

export function targetCapabilities(target) {
  const windows = platformOf(target) === 'windows';
  return Object.freeze({ commandShell: windows ? 'windows-powershell-5.1' : 'posix',
    fileTransfer: true, elevatedFileTransfer: true,
    pythonSource: !windows || typeof target?.pythonExecutable === 'string' && Boolean(target.pythonExecutable.trim()),
    agentCli: true, commandNameApproval: true });
}

export const validateWindowsCommand = command => {
  if (!utf8WithinLimit(command, COMMAND_MAX_BYTES) || !command.trim() || /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(command)) throw Error('Invalid Windows command');
};

export function classifyForTarget(target, classify) {
  if (platformOf(target) !== 'windows') return classify;
  return command => {
    validateWindowsCommand(command);
    // Module qualification avoids aliases, profiles and PATH command substitution.
    const readOnly = /^(?:Microsoft\.PowerShell\.Utility\\Get-Date|Microsoft\.PowerShell\.Management\\Get-Location)$/i.test(command.trim());
    return { class: readOnly ? 'read-only' : 'safe' };
  };
}

export const commandNamesForTarget = (target, command) => platformOf(target) === 'windows' ? windowsCommandLineNames(command) : commandLineNames(command);

export function requireTargetCapability(target, capability) {
  if (targetCapabilities(target)[capability] !== true) {
    throw Object.assign(Error(`Target platform does not support ${capability}`), { code: 'TARGET_CAPABILITY_UNSUPPORTED' });
  }
}

export function deniedForTarget(target, command, rule, fallback) {
  if (platformOf(target) !== 'windows') return fallback(command, rule);
  // This is a deny hint, not a PowerShell parser or proof that arbitrary code is safe.
  const words = command.toLowerCase().split(/[^a-z0-9_.+-]+/);
  return Boolean(rule?.deniedCommands.some(name => words.includes(name.toLowerCase().split(/[\\/]/).at(-1))));
}
