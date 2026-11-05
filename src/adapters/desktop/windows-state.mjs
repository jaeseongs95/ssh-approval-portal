import { createHash } from 'node:crypto';
import { prepareWindowsCommand } from '../ssh/windows-command.mjs';
import { desktopState } from '../../domain/desktop-state.mjs';

// Fixed metadata only: no account names, credentials, windows, services or settings are read/changed.
// WTSINFOEX is an aligned union on x64; older Windows has reversed lock flags and is refused.
export const WINDOWS_DESKTOP_STATE_SOURCE = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if([IntPtr]::Size -ne 8 -or [Environment]::OSVersion.Version -lt [Version]'6.2'){throw 'DESKTOP_SESSION_QUERY_UNSUPPORTED'}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AgsDesktopState {
 [StructLayout(LayoutKind.Sequential)] struct Session { public int Id; public IntPtr Name; public int State; }
 [StructLayout(LayoutKind.Explicit,Size=24)] struct Info {
  [FieldOffset(0)] public uint Level; [FieldOffset(8)] public uint Id;
  [FieldOffset(12)] public int State; [FieldOffset(16)] public int Flags;
 }
 public sealed class Row { public int id; public int state; public bool? locked; }
 [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
 [DllImport("wtsapi32.dll",EntryPoint="WTSEnumerateSessionsW",SetLastError=true)] static extern bool Enumerate(IntPtr s,int r,int v,out IntPtr p,out int n);
 [DllImport("wtsapi32.dll",EntryPoint="WTSQuerySessionInformationW",SetLastError=true)] static extern bool Query(IntPtr s,int id,int c,out IntPtr p,out int n);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
 public static Row[] Read() {
  IntPtr p=IntPtr.Zero;int count;
  if(!Enumerate(IntPtr.Zero,0,1,out p,out count)) throw new InvalidOperationException("DESKTOP_SESSION_QUERY_FAILED");
  var rows=new List<Row>();
  try {
   if(count<0 || count>256) throw new InvalidOperationException("DESKTOP_SESSION_QUERY_FAILED");
   int stride=Marshal.SizeOf(typeof(Session));
   for(int i=0;i<count;i++) {
    var s=(Session)Marshal.PtrToStructure(IntPtr.Add(p,i*stride),typeof(Session));
    if(s.Id<=0 || s.State==6 || s.State==8 || s.State==9) continue;
    var row=new Row {id=s.Id,state=s.State};IntPtr q=IntPtr.Zero;int bytes;
    try {
     if(Query(IntPtr.Zero,s.Id,25,out q,out bytes) && q!=IntPtr.Zero && bytes>=24) {
      var info=(Info)Marshal.PtrToStructure(q,typeof(Info));
      if(info.Level==1 && info.Id==(uint)s.Id) {row.state=info.State;row.locked=info.Flags==0?(bool?)true:info.Flags==1?(bool?)false:null;}
     }
    } finally {if(q!=IntPtr.Zero) WTSFreeMemory(q);}
    rows.Add(row);
   }
  } finally {if(p!=IntPtr.Zero) WTSFreeMemory(p);}
  return rows.ToArray();
 }
}
'@ | Out-Null
$boot=(Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToFileTimeUtc().ToString()
[pscustomobject]@{version=1;boot=$boot;consoleSessionId=[AgsDesktopState]::WTSGetActiveConsoleSessionId();sessions=@([AgsDesktopState]::Read())} | ConvertTo-Json -Depth 4 -Compress
`;

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = (code, now) => desktopState({ state: 'transport_ready', observedAt: now, generation: null,
  osSessionId: null, locked: null, sessionBindingVerified: false, displayBindingVerified: false, inputVerified: false,
  inputAllowed: true, ownerOnly: false, blockers: [code] });

/** WTS metadata is diagnostic, not proof that an unrelated RFB server captures that session. */
export function windowsDesktopState(value, now = Date.now()) {
  if (!value || value.version !== 1 || typeof value.boot !== 'string' || !/^[0-9]{1,20}$/.test(value.boot)
    || !Number.isSafeInteger(value.consoleSessionId) || value.consoleSessionId < 0 || value.consoleSessionId > 0xffff_ffff
    || !Array.isArray(value.sessions) || value.sessions.length > 256
    || value.sessions.some(row => !row || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > 0xffff_ffff
      || !Number.isInteger(row.state) || row.state < 0 || row.state > 9 || !(row.locked === null || typeof row.locked === 'boolean'))
    || new Set(value.sessions.map(row => row.id)).size !== value.sessions.length) return unavailable('DESKTOP_SESSION_QUERY_FAILED', now);
  const sessions = value.sessions.map(({ id, state, locked }) => ({ id, state, locked })).sort((a, b) => a.id - b.id);
  const console = sessions.find(row => row.id === value.consoleSessionId);
  // Never select a disconnected account just because it is the only named/login session.
  const locked = console?.locked ?? null;
  const authRequired = sessions.length === 0 || sessions.every(row => row.locked === true);
  return desktopState({ state: authRequired ? 'auth_required' : 'transport_ready', observedAt: now,
    generation: digest([value.boot, value.consoleSessionId, sessions]), osSessionId: console?.id ?? null, locked,
    // An unbound console observation cannot revoke input to an independently captured RFB session.
    sessionBindingVerified: false, displayBindingVerified: false, inputVerified: false, inputAllowed: true, ownerOnly: false,
    blockers: [...(authRequired ? ['DESKTOP_AUTH_REQUIRED'] : []), 'DESKTOP_SESSION_BINDING_UNVERIFIED'] });
}

export function createWindowsDesktopStateReader({ executeCommand, now = Date.now }) {
  const plan = prepareWindowsCommand(WINDOWS_DESKTOP_STATE_SOURCE);
  return async ({ profile, beforeDispatch, signal }) => {
    try {
      const result = await executeCommand(profile, plan.command, beforeDispatch, { stdin: plan.stdin, signal, timeoutMs: 15000, maxOutputBytes: 16384 });
      if (result.failed || result.execution?.exitCode !== 0 || result.execution?.captureFailed || result.execution?.stdout?.truncated) {
        const unsupported = result.data?.stderr?.includes('DESKTOP_SESSION_QUERY_UNSUPPORTED') === true;
        return unavailable(unsupported ? 'DESKTOP_SESSION_QUERY_UNSUPPORTED' : 'DESKTOP_SESSION_QUERY_FAILED', now());
      }
      if (typeof result.data?.stdout !== 'string' || Buffer.byteLength(result.data.stdout) > 16384) return unavailable('DESKTOP_SESSION_QUERY_FAILED', now());
      return windowsDesktopState(JSON.parse(result.data.stdout.trim()), now());
    } catch {
      // No exception text or process output crosses the owner/model boundary.
      return unavailable('DESKTOP_SESSION_QUERY_FAILED', now());
    }
  };
}
