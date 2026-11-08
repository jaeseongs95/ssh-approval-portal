# Execute only on the Windows test runner, elevated. Fixtures are isolated per run.
[CmdletBinding()]
param(
    [string]$PowerShellExe = 'powershell.exe',
    [string]$WorkRoot = (Join-Path 'C:/ProgramData' ('ssh-approval-helper-' + [Guid]::NewGuid().ToString('N'))),
    [switch]$WriterInheritOnlyOnly,
    [switch]$ForeignOwnerSnapshotOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($WriterInheritOnlyOnly -and $ForeignOwnerSnapshotOnly) { throw 'select only one isolated regression' }
if ($WriterInheritOnlyOnly) {
    $parentInputEncoding = [Console]::InputEncoding
    [Console]::Out.WriteLine((@{ parentPSMajor = [int]$PSVersionTable.PSVersion.Major;
        codePage = [int]$parentInputEncoding.CodePage; preambleBytes = [int]$parentInputEncoding.GetPreamble().Length } | ConvertTo-Json -Compress))
}
$passed = 0
$fixtureCreated = $false
$fixturePath = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
$fixtureParent = [IO.Path]::GetDirectoryName($fixturePath)
function Assert-True($condition, [string]$label) {
    if (!$condition) { throw $label }
    $script:passed++
}
function Start-Script([string]$scriptPath, [string]$arguments, [string]$inputText = '', [byte[]]$inputBytes = $null, [switch]$KeepInputOpen) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $PowerShellExe
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" ' + $arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        # Framework initializes the redirected stdin StreamWriter during Start;
        # its AutoFlush can emit a preamble before our BaseStream byte write.
        $savedInputEncoding = [Console]::InputEncoding
        try {
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            $null = $process.Start()
        } finally { [Console]::InputEncoding = $savedInputEncoding }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($null -eq $inputBytes) { $inputBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($inputText) }
        $inputStream = $process.StandardInput.BaseStream
        $inputStream.Write($inputBytes, 0, $inputBytes.Length)
        if ($KeepInputOpen) { $inputStream.Flush() } else { $inputStream.Close() }
        return @{ process = $process; stdout = $stdout; stderr = $stderr; inputStream = $inputStream }
    } catch { $process.Dispose(); throw }
}
function Complete-Script($pending) {
    $process = $pending.process
    try {
        if (!$process.WaitForExit(60000)) { $process.Kill(); throw 'helper timeout' }
        $stdout = $pending.stdout
        $stderr = $pending.stderr
        Assert-True ([string]::IsNullOrWhiteSpace($stderr.Result)) 'stderr must not contain exception details'
        $data = ConvertFrom-Json -InputObject $stdout.Result
        return @{ exitCode = $process.ExitCode; data = $data; raw = $stdout.Result }
    } finally { $process.Dispose() }
}
function Invoke-Script([string]$scriptPath, [string]$arguments, [string]$inputText = '') {
    return Complete-Script (Start-Script $scriptPath $arguments $inputText)
}
function Remove-FixtureEntry([IO.FileSystemInfo]$entry) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if (($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($entry.FullName, $false) }
        else { [IO.File]::Delete($entry.FullName) }
        return
    }
    if ($entry -is [IO.DirectoryInfo]) {
        foreach ($child in $entry.GetFileSystemInfos()) { Remove-FixtureEntry $child }
        [IO.Directory]::Delete($entry.FullName, $false)
    } else { [IO.File]::Delete($entry.FullName) }
}
function Request([string]$action = 'publish', [string]$path = $script:target) {
    return @{ action = $action; id = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N').Substring(0, 16);
        remotePath = $path; maxBytes = 67108864L; overwrite = $false; size = $script:bytes.Length; sha256 = $script:digest }
}
function Call($request) { return Invoke-Script $script:helper '' ($request | ConvertTo-Json -Compress) }
function Describe-Result($result) {
    # Whitelist-only failure metadata; never emit the helper response, path or exception text.
    $code = 'unclassified'
    if ($result.data.errorCode -cin @('PARENT_NOT_FOUND', 'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS',
        'UNSAFE_PATH', 'PATH_OUTSIDE_ALLOWED_ROOT', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST', 'OPERATION_FAILED')) { $code = $result.data.errorCode }
    $step = 'none'
    if ($result.data.nativeStep -cin @('native', 'create_directory', 'inspect', 'open', 'filesystem', 'final_path', 'read_input', 'read_security',
        'remove', 'rename_replace', 'rename_new', 'write_security', 'write_times', 'verify_security', 'verify_owner', 'verify_dacl', 'verify_control', 'verify_times', 'read_label', 'write_label', 'verify_label')) { $step = $result.data.nativeStep }
    $number = 0
    if ($result.data.nativeError -is [int] -and $result.data.nativeError -gt 0) { $number = $result.data.nativeError }
    $control = ''
    if ($step -cin @('verify_owner', 'verify_dacl', 'verify_control') -and
        $result.data.securityControl.before -is [int] -and $result.data.securityControl.before -ge 0 -and $result.data.securityControl.before -le 5388 -and
        $result.data.securityControl.after -is [int] -and $result.data.securityControl.after -ge 0 -and $result.data.securityControl.after -le 5388) {
        $control = '; controlBefore=' + $result.data.securityControl.before + '; controlAfter=' + $result.data.securityControl.after
    }
    return ('exit=' + [int]$result.exitCode + '; code=' + $code + '; step=' + $step + '; native=' + $number + $control)
}
function Refused($request, [string]$code) {
    $result = Call $request
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq $code) ('expected ' + $code + '; ' + (Describe-Result $result))
    Assert-True (!$result.raw.Contains('sensitive-marker')) 'content must never be returned'
}
function Stage($request) { [IO.File]::WriteAllBytes((Join-Path $script:stage ($request.id + '.part')), $script:bytes) }
function Assert-PrivateFile([string]$Path, [string]$AccountSid) {
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([string](Get-Acl -LiteralPath $Path).Sddl)
    Assert-True (($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) 'new file DACL is protected from parent inheritance'
    $otherAllows = @($descriptor.DiscretionaryAcl | Where-Object {
        $_ -is [Security.AccessControl.QualifiedAce] -and $_.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
        $_.SecurityIdentifier.Value -cnotin @($AccountSid, 'S-1-5-18', 'S-1-5-32-544')
    })
    Assert-True ($otherAllows.Count -eq 0) 'new file grants access only to account SYSTEM and Administrators'
}
function Initialize-ForeignOwnerFixtureNative {
    # Test-only OS probes. They never invoke private product functions or change a real installation.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class ForeignOwnerFixtureNative {
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct Privileges { public uint Count; public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
        public int Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status,
        IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")]
    static extern uint RtlNtStatusToDosError(int status);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref Privileges requested, uint length, out Privileges previous, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint SetNamedSecurityInfo(string path, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileEx(string existing, string destination, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
    public static void SetOwner(string path, string sid) {
        using (WindowsIdentity current = WindowsIdentity.GetCurrent()) {
            Luid luid;
            if (!LookupPrivilegeValue(null, "SeRestorePrivilege", out luid)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Privileges requested = new Privileges { Count = 1, Luid = luid, Attributes = 2 }, previous;
            uint needed;
            if (!AdjustTokenPrivileges(current.Token, false, ref requested, (uint)Marshal.SizeOf(typeof(Privileges)), out previous, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            int privilegeError = Marshal.GetLastWin32Error();
            if (privilegeError != 0) throw new Win32Exception(privilegeError);
            try {
                SecurityIdentifier owner = new SecurityIdentifier(sid);
                byte[] bytes = new byte[owner.BinaryLength]; owner.GetBinaryForm(bytes, 0);
                GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try {
                    uint error = SetNamedSecurityInfo(path, 1, 1, pin.AddrOfPinnedObject(), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                    if (error != 0) throw new Win32Exception((int)error);
                } finally { pin.Free(); }
            } finally {
                Privileges ignored; uint unused;
                if (!AdjustTokenPrivileges(current.Token, false, ref previous, (uint)Marshal.SizeOf(typeof(Privileges)), out ignored, out unused))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
    public static int ProbeAccess(string path, uint access, bool directory) {
        // Same access/options as product OpenLeaf, including metadata + SYNCHRONIZE,
        // without FILE_OPEN_FOR_BACKUP_INTENT. CreateFile BACKUP_SEMANTICS can bypass
        // READ_CONTROL denial when the caller already has enabled backup privileges.
        // https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile
        string nativePath = @"\??\" + Path.GetFullPath(path);
        IntPtr name = Marshal.StringToHGlobalUni(nativePath), unicode = IntPtr.Zero;
        SafeFileHandle handle = null;
        try {
            UnicodeString value = new UnicodeString { Length = checked((ushort)(nativePath.Length * 2)),
                MaximumLength = checked((ushort)(nativePath.Length * 2 + 2)), Buffer = name };
            unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(value, unicode, false);
            ObjectAttributes attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = IntPtr.Zero, ObjectName = unicode, Attributes = 0x40 };
            IoStatus io;
            int status = NtCreateFile(out handle, access | 0x100080, ref attributes, out io, IntPtr.Zero,
                0x80, 1, 1, 0x200000u | 0x20u | (directory ? 1u : 0x40u), IntPtr.Zero, 0);
            return status < 0 ? (int)RtlNtStatusToDosError(status) : 0;
        } finally {
            if (handle != null) handle.Dispose();
            if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
            Marshal.FreeHGlobal(name);
        }
    }
    public static int ProbeBackupDirectoryReadControl(string path) {
        // Diagnostic control only; no token privileges are enabled or changed here.
        using (SafeFileHandle handle = CreateFile(path, 0x20000, 7, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero))
            return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    }
    static int RenameAndRestore(string path, string parked) {
        if (!MoveFileEx(path, parked, 0)) return Marshal.GetLastWin32Error();
        if (!MoveFileEx(parked, path, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return 0;
    }
    public static int PinnedRename(string path, string parked, uint access, uint share, bool directory) {
        using (SafeFileHandle handle = CreateFile(path, access, share, IntPtr.Zero, 3, 0x200000u | (directory ? 0x2000000u : 0u), IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            return RenameAndRestore(path, parked);
        }
    }
    static int ReparseAndRestore(string directory, string target) {
        using (SafeFileHandle handle = CreateFile(directory, 0x40000000, 7, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero)) {
            if (handle.IsInvalid) return Marshal.GetLastWin32Error();
            byte[] substitute = Encoding.Unicode.GetBytes(@"\??\" + target), print = Encoding.Unicode.GetBytes(target);
            byte[] buffer = new byte[20 + substitute.Length + print.Length];
            Array.Copy(BitConverter.GetBytes(0xA0000003u), 0, buffer, 0, 4);
            Array.Copy(BitConverter.GetBytes((ushort)(buffer.Length - 8)), 0, buffer, 4, 2);
            Array.Copy(BitConverter.GetBytes((ushort)substitute.Length), 0, buffer, 10, 2);
            Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, buffer, 12, 2);
            Array.Copy(BitConverter.GetBytes((ushort)print.Length), 0, buffer, 14, 2);
            Array.Copy(substitute, 0, buffer, 16, substitute.Length);
            Array.Copy(print, 0, buffer, 18 + substitute.Length, print.Length);
            uint returned;
            if (!DeviceIoControl(handle, 0x900A4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                return Marshal.GetLastWin32Error();
            byte[] remove = new byte[8]; Array.Copy(BitConverter.GetBytes(0xA0000003u), remove, 4);
            if (!DeviceIoControl(handle, 0x900AC, remove, 8, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return 0;
        }
    }
    public sealed class Race : IDisposable {
        readonly Thread thread;
        volatile bool stop;
        public int Attempts, ParentRenameError = -1, LeafRenameError = -1, ReparseError = -1;
        public bool StageObserved;
        public string Failure;
        public Race(int processId, string parent, string leaf, string decoy, string stage, long size) {
            thread = new Thread(() => {
                try {
                    using (Process process = Process.GetProcessById(processId)) {
                        Stopwatch watch = Stopwatch.StartNew();
                        while (!stop && watch.ElapsedMilliseconds < 60000 && !process.HasExited) {
                            FileInfo part = new FileInfo(stage);
                            if (!part.Exists || part.Length >= size) { Thread.Sleep(1); continue; }
                            StageObserved = true;
                            ParentRenameError = RenameAndRestore(parent, parent + ".parked"); Attempts++;
                            LeafRenameError = RenameAndRestore(leaf, leaf + ".parked"); Attempts++;
                            ReparseError = ReparseAndRestore(parent, decoy); Attempts++;
                            break;
                        }
                    }
                } catch (Exception error) { Failure = error.GetType().Name; }
            });
            thread.IsBackground = true; thread.Start();
        }
        public void Dispose() {
            stop = true;
            if (!thread.Join(10000)) throw new TimeoutException("fixture race worker did not stop");
        }
    }
}
'@ | Out-Null
}
function Assert-ForeignOwnerPolicy($result, [string]$label) {
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'PERMISSION_DENIED' -and
        $result.data.origin -ceq 'policy' -and $result.data.policyReason -ceq 'UNTRUSTED_OWNER' -and
        !$result.data.PSObject.Properties['nativeStep']) $label
}
function Test-ForeignOwnerSnapshot([string]$Parent, [string]$Root, [string]$Install, [string]$Installer, [string]$AccountSid) {
    Initialize-ForeignOwnerFixtureNative
    $foreignSid = 'S-1-5-32-545'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        Assert-True ($foreignSid -cin @($identity.Groups | ForEach-Object { $_.Value }) -and
            $foreignSid -cnotin @($AccountSid, $identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) 'FO-SNAPSHOT fixture owner is a real token member outside account installer SYSTEM Administrators'
    } finally { $identity.Dispose() }
    $directory = Join-Path $Root 'foreign-owner'
    $null = [IO.Directory]::CreateDirectory($directory)
    $source = Join-Path $directory 'source.bin'
    [IO.File]::WriteAllBytes($source, $script:bytes)
    [ForeignOwnerFixtureNative]::SetOwner($directory, $foreignSid)
    $before = (Get-Acl -LiteralPath $directory).Sddl
    $leafBefore = (Get-Acl -LiteralPath $source).Sddl
    Assert-True ([Security.AccessControl.RawSecurityDescriptor]::new([string]$before).Owner.Value -ceq $foreignSid) 'FO-SNAPSHOT fixture has the requested foreign parent owner'
    $snapshot = Request 'snapshot' $source
    $snapshot.bypassRoot = $true
    $result = Call $snapshot
    # This is the unchanged red/green assertion: baseline must fail here for policy/UNTRUSTED_OWNER.
    if ($result.exitCode -ne 0) {
        [Console]::Out.WriteLine((@{ caseId = 'FO-SNAPSHOT-01'; exitCode = $result.exitCode;
            errorCode = $result.data.errorCode; origin = $result.data.origin; policyReason = $result.data.policyReason } | ConvertTo-Json -Compress))
    }
    Assert-True ($result.exitCode -eq 0 -and $result.data.sha256 -ceq $script:digest -and
        $result.data.size -eq $script:bytes.Length -and $result.data.rootPolicyApplied -ceq 'test-server-bypass') ('FO-SNAPSHOT-01 TEST snapshot accepts foreign-owner source parent; ' + (Describe-Result $result))
    $part = Join-Path $script:stage ($snapshot.id + '.part')
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($part)) -ceq [Convert]::ToBase64String($script:bytes)) 'FO-SNAPSHOT-01 snapshot has exact independent bytes'
    Assert-True ((Get-Acl -LiteralPath $directory).Sddl -ceq $before -and (Get-Acl -LiteralPath $source).Sddl -ceq $leafBefore) 'FO-SNAPSHOT-01 source owner and DACL are unchanged'
    $cleanup = Request 'cleanup'; $cleanup.id = $snapshot.id
    Assert-True ((Call $cleanup).exitCode -eq 0) 'FO-SNAPSHOT-01 stage is cleaned'
    foreach ($explicitFalse in @($false, $true)) {
        $normal = Request 'snapshot' $source
        if ($explicitFalse) { $normal.bypassRoot = $false }
        Assert-ForeignOwnerPolicy (Call $normal) 'FO-SNAPSHOT-02 normal in-root snapshot retains owner policy'
        Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($normal.id + '.part')))) 'FO-SNAPSHOT-02 refused normal snapshot creates no part'
    }
    $publish = Request 'publish' (Join-Path $directory 'must-not-publish.bin'); $publish.bypassRoot = $true
    Stage $publish
    Assert-ForeignOwnerPolicy (Call $publish) 'FO-SNAPSHOT-02 bypass publish retains owner policy'
    Assert-True (!(Test-Path -LiteralPath $publish.remotePath) -and (Get-Acl -LiteralPath $directory).Sddl -ceq $before) 'FO-SNAPSHOT-02 publish refusal preserves source parent'
    $cleanup.id = $publish.id; Assert-True ((Call $cleanup).exitCode -eq 0) 'FO-SNAPSHOT-02 refused publish stage is cleaned'
    foreach ($trustedPath in @($script:stage, $Install)) {
        $trustedAcl = Get-Acl -LiteralPath $trustedPath
        $trustedOwner = $trustedAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        try {
            [ForeignOwnerFixtureNative]::SetOwner($trustedPath, $foreignSid)
            $request = Request 'snapshot' $source; $request.bypassRoot = $true
            Assert-ForeignOwnerPolicy (Call $request) 'FO-SNAPSHOT-03 stage and install retain foreign-owner rejection'
            Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($request.id + '.part')))) 'FO-SNAPSHOT-03 rejected protected root creates no part'
        } finally { [ForeignOwnerFixtureNative]::SetOwner($trustedPath, $trustedOwner) }
        Assert-True ((Get-Acl -LiteralPath $trustedPath).Sddl -ceq $trustedAcl.Sddl) 'FO-SNAPSHOT-03 protected root owner is restored exactly'
    }
    $installArguments = '-AccountSid "' + $AccountSid + '" -FileRoot "' + (Join-Path $directory 'new-files') +
        '" -InstallRoot "' + (Join-Path $directory 'new-helper') + '" -StageRoot "' + (Join-Path $directory 'new-stage') + '"'
    $result = Invoke-Script $Installer $installArguments
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'PERMISSION_DENIED') 'FO-SNAPSHOT-03 installer rejects foreign-owner parent'
    foreach ($name in @('new-files', 'new-helper', 'new-stage')) {
        Assert-True (!(Test-Path -LiteralPath (Join-Path $directory $name))) 'FO-SNAPSHOT-03 refused installer creates no protected root'
    }
    $noControl = Join-Path $Root 'foreign-owner-no-read-control'
    $null = [IO.Directory]::CreateDirectory($noControl)
    $noControlLeaf = Join-Path $noControl 'source.bin'; [IO.File]::WriteAllBytes($noControlLeaf, $script:bytes)
    [ForeignOwnerFixtureNative]::SetOwner($noControl, $foreignSid)
    [ForeignOwnerFixtureNative]::SetOwner($noControlLeaf, $foreignSid)
    $restoreParent = Get-Acl -LiteralPath $noControl; $restoreLeaf = Get-Acl -LiteralPath $noControlLeaf
    try {
        foreach ($path in @($noControl, $noControlLeaf)) {
            $acl = Get-Acl -LiteralPath $path
            foreach ($deniedSid in @($AccountSid, 'S-1-3-4')) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($deniedSid),
                    [Security.AccessControl.FileSystemRights]::ReadPermissions, [Security.AccessControl.AccessControlType]::Deny))
            }
            Set-Acl -LiteralPath $path -AclObject $acl
        }
        $parentSourceAccessError = [ForeignOwnerFixtureNative]::ProbeAccess($noControl, 0xA0, $true)
        $parentReadControlError = [ForeignOwnerFixtureNative]::ProbeAccess($noControl, 0x20000, $true)
        $leafSourceAccessError = [ForeignOwnerFixtureNative]::ProbeAccess($noControlLeaf, 0x100081, $false)
        $leafReadControlError = [ForeignOwnerFixtureNative]::ProbeAccess($noControlLeaf, 0x20000, $false)
        $backupParentReadControlError = [ForeignOwnerFixtureNative]::ProbeBackupDirectoryReadControl($noControl)
        [Console]::Out.WriteLine(([ordered]@{ caseId = 'FO-SNAPSHOT-04'; phase = 'fixture-access-probe';
            probeApi = 'NtCreateFile'; shareMask = '0x1'; backupIntent = $false;
            directoryOptions = '0x200021'; leafOptions = '0x200060';
            parentSourceAccessMask = '0x1000A0'; parentSourceAccessError = $parentSourceAccessError;
            parentReadControlMask = '0x120080'; parentReadControlError = $parentReadControlError;
            leafSourceAccessMask = '0x100081'; leafSourceAccessError = $leafSourceAccessError;
            leafReadControlMask = '0x120080'; leafReadControlError = $leafReadControlError;
            backupControlApi = 'CreateFile'; backupControlFlags = '0x2200000';
            backupParentReadControlMask = '0x20000'; backupParentReadControlError = $backupParentReadControlError } | ConvertTo-Json -Compress))
        Assert-True ($parentSourceAccessError -eq 0 -and $parentReadControlError -eq 5 -and
            $leafSourceAccessError -eq 0 -and $leafReadControlError -eq 5) 'FO-SNAPSHOT-04 fixture permits source access but OS denies READ_CONTROL on parent and leaf'
        $request = Request 'snapshot' $noControlLeaf; $request.bypassRoot = $true
        $result = Call $request
        Assert-True ($result.exitCode -eq 0 -and $result.data.sha256 -ceq $script:digest) ('FO-SNAPSHOT-04 TEST snapshot needs no source READ_CONTROL; ' + (Describe-Result $result))
        Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $script:stage ($request.id + '.part')))) -ceq [Convert]::ToBase64String($script:bytes)) 'FO-SNAPSHOT-04 exact independent source bytes'
        $cleanup.id = $request.id; Assert-True ((Call $cleanup).exitCode -eq 0) 'FO-SNAPSHOT-04 stage is cleaned'
    } finally {
        Set-Acl -LiteralPath $noControlLeaf -AclObject $restoreLeaf
        Set-Acl -LiteralPath $noControl -AclObject $restoreParent
    }
    # Keep ACL-mutating fixtures separate from the FO-SNAPSHOT-01 source baseline.
    # TEST r4 showed Set-Acl restore adds D:AI while the product preserves exact SDDL.
    $deniedSource = Join-Path $directory 'denied-source.bin'
    [IO.File]::WriteAllBytes($deniedSource, $script:bytes)
    $restoreSource = Get-Acl -LiteralPath $deniedSource
    $deniedAcl = Get-Acl -LiteralPath $deniedSource
    $deniedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($AccountSid),
        [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Deny))
    try {
        Set-Acl -LiteralPath $deniedSource -AclObject $deniedAcl
        $deniedBefore = (Get-Acl -LiteralPath $deniedSource).Sddl
        $deniedParentBefore = (Get-Acl -LiteralPath $directory).Sddl
        $request = Request 'snapshot' $deniedSource; $request.bypassRoot = $true
        $result = Call $request
        [Console]::Out.WriteLine(([ordered]@{ caseId = 'FO-SNAPSHOT-05'; phase = 'product-acl-compare';
            parentSddlBefore = $deniedParentBefore; parentSddlAfter = (Get-Acl -LiteralPath $directory).Sddl;
            sourceSddlBefore = $deniedBefore; sourceSddlAfter = (Get-Acl -LiteralPath $deniedSource).Sddl } | ConvertTo-Json -Compress))
        Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'PERMISSION_DENIED' -and
            $result.data.origin -ceq 'os' -and $result.data.nativeStep -ceq 'open' -and $result.data.nativeError -eq 5 -and
            !$result.data.PSObject.Properties['policyReason']) 'FO-SNAPSHOT-05 actual OS source read denial stays distinct from policy refusal'
        Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($request.id + '.part'))) -and
            (Get-Acl -LiteralPath $deniedSource).Sddl -ceq $deniedBefore) 'FO-SNAPSHOT-05 read denial creates no part and never repairs ACL'
    } finally { Set-Acl -LiteralPath $deniedSource -AclObject $restoreSource }
    [Console]::Out.WriteLine(([ordered]@{ caseId = 'FO-SNAPSHOT-05'; phase = 'fixture-restore-compare';
        parentSddlBefore = $before; parentSddlAfter = (Get-Acl -LiteralPath $directory).Sddl;
        sourceSddlBefore = $restoreSource.Sddl; sourceSddlAfter = (Get-Acl -LiteralPath $deniedSource).Sddl } | ConvertTo-Json -Compress))
    $decoy = Join-Path $Parent 'foreign-owner-decoy'; $null = [IO.Directory]::CreateDirectory($decoy)
    $decoyLeaf = Join-Path $decoy 'source.bin'; $decoyBytes = [Text.Encoding]::UTF8.GetBytes('different-decoy-bytes')
    [IO.File]::WriteAllBytes($decoyLeaf, $decoyBytes)
    $junction = Join-Path $directory 'junction'; $null = New-Item -ItemType Junction -Path $junction -Target $decoy
    $symlink = Join-Path $directory 'symlink.bin'; $null = New-Item -ItemType SymbolicLink -Path $symlink -Target $decoyLeaf
    $hardlink = Join-Path $directory 'hardlink.bin'; $null = New-Item -ItemType HardLink -Path $hardlink -Target $decoyLeaf
    foreach ($path in @((Join-Path $junction 'source.bin'), $symlink, $hardlink, ($source + ':stream'))) {
        $request = Request 'snapshot' $path; $request.bypassRoot = $true
        Refused $request 'UNSAFE_PATH'
        Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($request.id + '.part')))) 'FO-SNAPSHOT-06 unsafe source creates no stage part'
    }
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($source)) -ceq [Convert]::ToBase64String($script:bytes) -and
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($decoyLeaf)) -ceq [Convert]::ToBase64String($decoyBytes)) 'FO-SNAPSHOT-06 original and decoy bytes stay unchanged'
    $pinDirectory = Join-Path $Parent 'foreign-owner-share-probe'; $null = [IO.Directory]::CreateDirectory($pinDirectory)
    $pinLeaf = Join-Path $pinDirectory 'source.bin'; [IO.File]::WriteAllBytes($pinLeaf, $script:bytes)
    Assert-True ([ForeignOwnerFixtureNative]::PinnedRename($pinDirectory, ($pinDirectory + '.parked'), 0x80, 3, $true) -eq 0) 'FO-SNAPSHOT-07 control metadata-only parent pin permits actual rename'
    Assert-True ([ForeignOwnerFixtureNative]::PinnedRename($pinDirectory, ($pinDirectory + '.parked'), 0xA0, 3, $true) -eq 32) 'FO-SNAPSHOT-07 FILE_TRAVERSE parent pin blocks actual rename with sharing violation'
    Assert-True ([ForeignOwnerFixtureNative]::PinnedRename($pinLeaf, ($pinLeaf + '.parked'), 0x100081, 1, $false) -eq 32) 'FO-SNAPSHOT-07 FILE_READ_DATA leaf pin blocks actual rename with sharing violation'
    $raceDirectory = Join-Path $Root 'foreign-owner-race'; $null = [IO.Directory]::CreateDirectory($raceDirectory)
    $raceLeaf = Join-Path $raceDirectory 'source.bin'
    $raceBytes = [byte[]]::new(67108864); [Array]::Copy($script:bytes, $raceBytes, $script:bytes.Length)
    $raceBytes[$raceBytes.Length - 1] = 123
    [IO.File]::WriteAllBytes($raceLeaf, $raceBytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $raceHash = [BitConverter]::ToString($sha.ComputeHash($raceBytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    [ForeignOwnerFixtureNative]::SetOwner($raceDirectory, $foreignSid)
    $request = Request 'snapshot' $raceLeaf; $request.bypassRoot = $true
    $racePart = Join-Path $script:stage ($request.id + '.part')
    $pending = $null; $race = $null
    try {
        $pending = Start-Script $script:helper '' ($request | ConvertTo-Json -Compress)
        $race = [ForeignOwnerFixtureNative+Race]::new($pending.process.Id, $raceDirectory, $raceLeaf, $decoy, $racePart, $raceBytes.Length)
        $result = Complete-Script $pending; $pending = $null
        $race.Dispose()
        [Console]::Out.WriteLine((@{ caseId = 'FO-SNAPSHOT-08'; stageObserved = $race.StageObserved; attempts = $race.Attempts;
            parentRenameError = $race.ParentRenameError; leafRenameError = $race.LeafRenameError; reparseError = $race.ReparseError;
            workerFailure = $race.Failure } | ConvertTo-Json -Compress))
        Assert-True ([string]::IsNullOrEmpty($race.Failure)) 'FO-SNAPSHOT-08 native race worker completed without fixture failure'
        Assert-True ($race.StageObserved -and $race.Attempts -eq 3) 'FO-SNAPSHOT-08 RACE_OBSERVATION_MISSING is a preparation gap, not a product red'
        if ($result.exitCode -eq 0) {
            Assert-True ($result.data.sha256 -ceq $raceHash -and $result.data.size -eq $raceBytes.Length -and
                $result.data.rootPolicyApplied -ceq 'test-server-bypass') 'FO-SNAPSHOT-08 successful raced snapshot reports only pinned source hash and size'
            Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($racePart)) -ceq [Convert]::ToBase64String($raceBytes)) 'FO-SNAPSHOT-08 successful raced snapshot has exact pinned source bytes'
        } else {
            Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -cin @('UNSAFE_PATH', 'FILE_CHANGED', 'PERMISSION_DENIED', 'FILE_NOT_FOUND', 'PARENT_NOT_FOUND') -and
                !(Test-Path -LiteralPath $racePart)) ('FO-SNAPSHOT-08 raced refusal leaves no part; ' + (Describe-Result $result))
        }
    } finally {
        if ($null -ne $race) { $race.Dispose() }
        if ($null -ne $pending) {
            if (!$pending.process.HasExited) { $pending.process.Kill() }
            $pending.process.Dispose()
        }
    }
    $cleanup.id = $request.id; Assert-True ((Call $cleanup).exitCode -eq 0) 'FO-SNAPSHOT-08 raced stage is cleaned'
    [Console]::Out.WriteLine(([ordered]@{ caseId = 'FO-SNAPSHOT-FINAL'; phase = 'source-acl-compare';
        parentSddlBefore = $before; parentSddlAfter = (Get-Acl -LiteralPath $directory).Sddl;
        sourceSddlBefore = $leafBefore; sourceSddlAfter = (Get-Acl -LiteralPath $source).Sddl } | ConvertTo-Json -Compress))
    Assert-True ((Get-Acl -LiteralPath $directory).Sddl -ceq $before -and (Get-Acl -LiteralPath $source).Sddl -ceq $leafBefore) 'FO-SNAPSHOT source ACL and owner remain exact after all cases'
}
function Test-InheritOnlyWriter([string]$Parent) {
    # INHERIT_ONLY_ACE is not effective on this directory (Microsoft Win32 contract).
    # Keep the same assertion body for the full suite and the isolated old-native red run.
    $directory = Join-Path $Parent 'writer-inherit-only'
    $null = [IO.Directory]::CreateDirectory($directory)
    $acl = Get-Acl -LiteralPath $directory
    $creator = [Security.Principal.SecurityIdentifier]::new('S-1-3-0')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($creator,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $directory -AclObject $acl
    $before = (Get-Acl -LiteralPath $directory).Sddl
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([string]$before)
    $creatorAces = @($descriptor.DiscretionaryAcl | Where-Object {
        $_ -is [Security.AccessControl.QualifiedAce] -and $_.SecurityIdentifier.Value -ceq 'S-1-3-0'
    })
    Assert-True ($creatorAces.Count -gt 0 -and @($creatorAces | Where-Object {
        (([int]$_.AceFlags -band 8) -eq 0) -or (([int]$_.AccessMask -band 0x500D0156) -eq 0)
    }).Count -eq 0) 'WRITER-ACL-01 fixture has only inherit-only Creator Owner writer ACEs'
    $publish = Request 'publish' (Join-Path $directory 'binary.bin')
    $publish.bypassRoot = $true
    $snapshot = Request 'snapshot' $publish.remotePath
    $snapshot.bypassRoot = $true
    Stage $publish
    try {
        $result = Call $publish
        Assert-True ($result.exitCode -eq 0 -and $result.data.published -and $result.data.rootPolicyApplied -ceq 'test-server-bypass') ('WRITER-ACL-01 inherit-only Creator Owner permits publish; ' + (Describe-Result $result))
        Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($publish.remotePath)) -ceq [Convert]::ToBase64String($script:bytes)) 'WRITER-ACL-01 published binary equals independent input'
        $result = Call $snapshot
        Assert-True ($result.exitCode -eq 0 -and $result.data.sha256 -ceq $script:digest) 'WRITER-ACL-01 inherit-only Creator Owner permits snapshot'
        Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $script:stage ($snapshot.id + '.part')))) -ceq [Convert]::ToBase64String($script:bytes)) 'WRITER-ACL-01 snapshot binary equals independent input'
        Assert-True ((Get-Acl -LiteralPath $directory).Sddl -ceq $before) 'WRITER-ACL-01 helper never repairs directory ACL'
    } finally {
        foreach ($id in @($publish.id, $snapshot.id)) {
            $cleanup = Request 'cleanup'
            $cleanup.id = $id
            Assert-True ((Call $cleanup).exitCode -eq 0) 'WRITER-ACL-01 original session stage can be cleaned'
        }
    }
}
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if (Test-Path -LiteralPath $WorkRoot) { throw 'fixture path already exists' }
    if ([string]::IsNullOrWhiteSpace($fixtureParent) -or !(Test-Path -LiteralPath $fixtureParent -PathType Container)) { throw 'fixture parent must exist' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Add-Type -Path (Join-Path $PSScriptRoot '../scripts/windows-file-native.cs') -ErrorAction Stop | Out-Null
    # A deny-only Administrators SID exercises the same guard as a filtered SSH token.
    # No account, credential, policy or machine setting is created or modified.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class RestrictedAdministratorTest {
    [StructLayout(LayoutKind.Sequential)]
    struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, ref SidAndAttributes disable,
        uint privilegeCount, IntPtr privileges, uint restrictCount, IntPtr restrict, out SafeAccessTokenHandle result);
    public static SafeAccessTokenHandle CreateToken() {
        byte[] bytes = new byte[68];
        SecurityIdentifier admin = new SecurityIdentifier("S-1-5-32-544");
        admin.GetBinaryForm(bytes, 0);
        GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        SafeAccessTokenHandle restricted = null;
        try {
            SidAndAttributes sid = new SidAndAttributes { Sid = pin.AddrOfPinnedObject(), Attributes = 0 };
            using (WindowsIdentity current = WindowsIdentity.GetCurrent()) {
                if (!CreateRestrictedToken(current.Token, 0, 1, ref sid, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return restricted;
        } catch { if (restricted != null) restricted.Dispose(); throw; }
        finally { pin.Free(); }
    }
}
'@ | Out-Null
    [SshApproval.WindowsFiles]::RequireAdministrator()
    $restrictedToken = [RestrictedAdministratorTest]::CreateToken()
    try {
        [Security.Principal.WindowsIdentity]::RunImpersonated($restrictedToken, [Action] {
            $denied = $false
            try { [SshApproval.WindowsFiles]::RequireAdministrator() }
            catch {
                $failure = $_.Exception
                while ($null -ne $failure) {
                    if ($failure.PSObject.Properties['Code'] -and $failure.Code -ceq 'PERMISSION_DENIED') { $denied = $true; break }
                    $failure = $failure.InnerException
                }
            }
            Assert-True $denied 'deny-only Administrators token cannot request elevation'
        })
    } finally { $restrictedToken.Dispose() }
    $fixtureSddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $sid + ')'
    [SshApproval.WindowsFiles]::CreatePrivateDirectory($WorkRoot, $fixtureSddl, $sid, $sid, $false)
    $fixtureCreated = $true
    Assert-True (Test-Path -LiteralPath $WorkRoot -PathType Container) 'default ProgramData parent supports protected directory creation'
    $install = Join-Path $WorkRoot 'helper'
    $script:stage = Join-Path $WorkRoot 'incoming'
    $root = Join-Path $WorkRoot 'files'
    $script:target = Join-Path $root 'result.bin'
    $installer = Join-Path $PSScriptRoot '../scripts/install-windows-helper.ps1'
    $arguments = '-AccountSid "' + $sid + '" -FileRoot "' + $root + '" -InstallRoot "' + $install + '" -StageRoot "' + $script:stage + '"'
    $installed = Invoke-Script $installer $arguments
    Assert-True ($installed.exitCode -eq 0 -and $installed.data.installed) 'new dedicated installation'
    $script:helper = $installed.data.helper
    $authorization = Request 'authorize'
    $authorization.elevate = $true
    $authorized = Call $authorization
    Assert-True ($authorized.exitCode -eq 0 -and $authorized.data.authorized -and $authorized.data.elevated) ('connected administrator token is authorized; ' + (Describe-Result $authorized))
    Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($authorization.id + '.part')))) 'authorization does not create a staged file'
    $reinstall = Invoke-Script $installer $arguments
    Assert-True ($reinstall.exitCode -eq 1 -and $reinstall.data.errorCode -eq 'DESTINATION_EXISTS') 'existing installation must be preserved'
    $unsafeParent = Join-Path $WorkRoot 'unsafe-parent'
    $null = [IO.Directory]::CreateDirectory($unsafeParent)
    $unsafeAcl = Get-Acl -LiteralPath $unsafeParent
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $unsafeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $unsafeParent -AclObject $unsafeAcl
    $unsafeSddl = (Get-Acl -LiteralPath $unsafeParent).Sddl
    $unsafeArguments = '-AccountSid "' + $sid + '" -FileRoot "' + (Join-Path $unsafeParent 'files') +
        '" -InstallRoot "' + (Join-Path $unsafeParent 'helper') + '" -StageRoot "' + (Join-Path $unsafeParent 'incoming') + '"'
    $refusedInstall = Invoke-Script $installer $unsafeArguments
    Assert-True ($refusedInstall.exitCode -eq 1 -and $refusedInstall.data.errorCode -ceq 'PERMISSION_DENIED') 'Users Modify ancestor must reject installation'
    Assert-True ((Get-Acl -LiteralPath $unsafeParent).Sddl -ceq $unsafeSddl) 'installer cannot change an unsafe parent ACL'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $unsafeParent 'helper'))) 'unsafe ancestry cannot create protected roots'
    $attributeParent = Join-Path $WorkRoot 'attribute-parent'
    $null = [IO.Directory]::CreateDirectory($attributeParent)
    $attributeAcl = Get-Acl -LiteralPath $attributeParent
    $attributeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        ([Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::CreateFiles),
        [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $attributeParent -AclObject $attributeAcl
    $attributeArguments = '-AccountSid "' + $sid + '" -FileRoot "' + (Join-Path $attributeParent 'files') +
        '" -InstallRoot "' + (Join-Path $attributeParent 'helper') + '" -StageRoot "' + (Join-Path $attributeParent 'incoming') + '"'
    $refusedAttributes = Invoke-Script $installer $attributeArguments
    Assert-True ($refusedAttributes.exitCode -eq 1 -and $refusedAttributes.data.errorCode -ceq 'PERMISSION_DENIED') 'attribute-writable final parent must reject installation'
    Assert-True (@(Get-ChildItem -LiteralPath $attributeParent -Force).Count -eq 0) 'attribute-writable empty parent remains unchanged'
    $script:bytes = [Text.Encoding]::UTF8.GetBytes("sensitive-marker`r`nUnicode: 한글`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $script:digest = [BitConverter]::ToString($sha.ComputeHash($script:bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }

    if (!$WriterInheritOnlyOnly) { Test-ForeignOwnerSnapshot $WorkRoot $root $install $installer $sid }
    if ($ForeignOwnerSnapshotOnly) {
        [Console]::Out.WriteLine((@{ passed = $passed; selectedCase = 'FO-SNAPSHOT-01..08' } | ConvertTo-Json -Compress))
        exit 0
    }
    Test-InheritOnlyWriter $WorkRoot
    if ($WriterInheritOnlyOnly) {
        [Console]::Out.WriteLine((@{ passed = $passed; selectedCase = 'WRITER-ACL-01' } | ConvertTo-Json -Compress))
        exit 0
    }

    $eofRequest = Request 'publish' (Join-Path $root 'eof-probe.bin')
    Stage $eofRequest
    $pending = Start-Script $script:helper '' ($eofRequest | ConvertTo-Json -Compress) -KeepInputOpen
    try {
        Start-Sleep -Milliseconds 500
        Assert-True (!$pending.process.HasExited -and !(Test-Path -LiteralPath $eofRequest.remotePath)) 'valid metadata cannot publish before stdin EOF'
        $pending.inputStream.Close()
        $result = Complete-Script $pending
        $pending = $null
        Assert-True ($result.exitCode -eq 0 -and $result.data.published) 'valid metadata publishes only after stdin EOF'
    } finally {
        if ($null -ne $pending) {
            if (!$pending.process.HasExited) { $pending.process.Kill() }
            $pending.process.Dispose()
        }
    }
    $request = Request
    Stage $request
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published -and $result.data.sha256 -ceq $script:digest -and $result.data.size -eq $script:bytes.Length) 'publish metadata'
    Assert-True ($result.data.rootPolicyApplied -ceq 'configured-root') 'default request applies configured root policy'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:target)) -ceq [Convert]::ToBase64String($script:bytes)) 'binary publish bytes'
    Refused $request 'DESTINATION_EXISTS'
    $request.overwrite = $true
    [IO.File]::SetCreationTimeUtc($script:target, [DateTime]::new(2020, 1, 2, 3, 4, 5, [DateTimeKind]::Utc))
    [IO.File]::SetLastAccessTimeUtc($script:target, [DateTime]::new(2021, 2, 3, 4, 5, 6, [DateTimeKind]::Utc))
    [IO.File]::SetLastWriteTimeUtc($script:target, [DateTime]::new(2022, 3, 4, 5, 6, 7, [DateTimeKind]::Utc))
    $times = @([IO.File]::GetCreationTimeUtc($script:target), [IO.File]::GetLastAccessTimeUtc($script:target), [IO.File]::GetLastWriteTimeUtc($script:target))
    $acl = (Get-Acl -LiteralPath $script:target).Sddl
    $owner = (Get-Acl -LiteralPath $script:target).Owner
    $request.elevate = $true
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published) ('atomic overwrite; ' + (Describe-Result $result))
    Assert-True ((Get-Acl -LiteralPath $script:target).Sddl -ceq $acl) 'overwrite retains destination DACL'
    Assert-True ((Get-Acl -LiteralPath $script:target).Owner -ceq $owner) 'overwrite retains destination owner'
    Assert-True ([IO.File]::GetCreationTimeUtc($script:target) -eq $times[0] -and
        [IO.File]::GetLastAccessTimeUtc($script:target) -eq $times[1] -and
        [IO.File]::GetLastWriteTimeUtc($script:target) -eq $times[2]) 'overwrite retains creation access and write times after handle close'
    $reader = [IO.File]::Open($script:target, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
    try {
        $result = Call $request
        Assert-True ($result.exitCode -eq 0 -and $result.data.published) ('overwrite preserves shared-delete reader; ' + (Describe-Result $result))
        Assert-True ($reader.ReadByte() -eq $script:bytes[0]) 'replaced file remains readable through retained handle'
    } finally { $reader.Dispose() }
    $reader = [IO.File]::Open($script:target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { Refused $request 'PERMISSION_DENIED' } finally { $reader.Dispose() }
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:target)) -ceq [Convert]::ToBase64String($script:bytes)) 'blocked overwrite preserves destination bytes'
    $customAcl = Get-Acl -LiteralPath $script:target
    $customAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        [Security.AccessControl.FileSystemRights]::ReadAttributes, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $script:target -AclObject $customAcl
    $customSddl = (Get-Acl -LiteralPath $script:target).Sddl
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and (Get-Acl -LiteralPath $script:target).Sddl -ceq $customSddl) ('overwrite copies a differing explicit safe DACL with inheritance enabled; ' + (Describe-Result $result))
    $protectedAcl = Get-Acl -LiteralPath $script:target
    $protectedAcl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $script:target -AclObject $protectedAcl
    $protectedSddl = (Get-Acl -LiteralPath $script:target).Sddl
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and (Get-Acl -LiteralPath $script:target).Sddl -ceq $protectedSddl) ('overwrite copies a differing protected destination DACL; ' + (Describe-Result $result))
    $null = & icacls.exe $script:target /setintegritylevel 'L'
    Assert-True ($LASTEXITCODE -eq 0) 'fixture mandatory low integrity label is set'
    $labelBefore = (& icacls.exe $script:target) -join "`n"
    Assert-True ($LASTEXITCODE -eq 0) 'fixture mandatory label can be read'
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published) ('overwrite retains mandatory label; ' + (Describe-Result $result))
    $labelAfter = (& icacls.exe $script:target) -join "`n"
    Assert-True ($LASTEXITCODE -eq 0 -and $labelAfter -ceq $labelBefore) 'overwrite cannot replace a mandatory low integrity label with its default label'
    $request.action = 'cleanup'
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.cleaned) 'cleanup staged data'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($request.id + '.part')))) 'cleanup removed only own stage'
    Assert-True ((Call $request).exitCode -eq 0) 'cleanup idempotent'

    $snapshot = Request 'snapshot'
    $snapshot.elevate = $true
    $result = Call $snapshot
    Assert-True ($result.exitCode -eq 0 -and $result.data.sha256 -ceq $script:digest -and $result.data.size -eq $script:bytes.Length) 'snapshot metadata'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $script:stage ($snapshot.id + '.part')))) -ceq [Convert]::ToBase64String($script:bytes)) 'snapshot binary bytes'
    Refused $snapshot 'DESTINATION_EXISTS'
    $snapshot.id = (Request).id
    $snapshot.maxBytes = 1
    Refused $snapshot 'FILE_TOO_LARGE'

    $changed = Request 'publish' (Join-Path $root 'changed.bin')
    Stage $changed
    $changed.sha256 = '0' * 64
    Refused $changed 'FILE_CHANGED'
    Assert-True (!(Test-Path -LiteralPath $changed.remotePath)) 'hash mismatch cannot publish'
    Assert-True (@(Get-ChildItem -LiteralPath $root -Filter '.ssh-approval-*.part').Count -eq 0) 'failed publish removes temporary file'
    $changed.size++
    Refused $changed 'FILE_CHANGED'
    Refused (Request 'snapshot' (Join-Path $root 'missing.bin')) 'FILE_NOT_FOUND'
    Refused (Request 'publish' (Join-Path $root 'missing-parent/file.bin')) 'PARENT_NOT_FOUND'
    $outsideRequest = Request 'snapshot' (Join-Path $WorkRoot 'files-other/file.bin')
    $outsideRequest.allowedRoot = $WorkRoot
    $outsideResult = Call $outsideRequest
    Assert-True ($outsideResult.exitCode -eq 1 -and $outsideResult.data.errorCode -ceq 'PATH_OUTSIDE_ALLOWED_ROOT') 'normal mode distinguishes root policy from unsafe path'
    Assert-True ($outsideResult.data.allowedRoot -ceq $root) 'allowed root metadata comes from helper config, never request'

    $bypassDirectory = Join-Path $WorkRoot 'bypass'
    $null = [IO.Directory]::CreateDirectory($bypassDirectory)
    $bypass = Request 'publish' (Join-Path $bypassDirectory 'uploaded.bin')
    $bypass.bypassRoot = $true
    Stage $bypass
    $parkedRoot = Join-Path $WorkRoot 'parked-files'
    [IO.Directory]::Move($root, $parkedRoot)
    try {
        $policy = Request 'policy'
        foreach ($flag in @($false, $true)) {
            $policy.bypassRoot = $flag
            $policyResult = Call $policy
            $expectedPolicy = if ($flag) { 'test-server-bypass' } else { 'configured-root' }
            Assert-True ($policyResult.exitCode -eq 0 -and $policyResult.data.protocol -ceq 'file-path-policy-v1' -and
                $policyResult.data.allowedRoot -ceq $root -and $policyResult.data.rootPolicyApplied -ceq $expectedPolicy) 'policy probe is independent of destination root availability'
        }
        $result = Call $bypass
        Assert-True ($result.exitCode -eq 0 -and $result.data.published -and $result.data.rootPolicyApplied -ceq 'test-server-bypass') 'bypass publishes outside an unavailable configured root'
        Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($bypass.remotePath)) -ceq [Convert]::ToBase64String($script:bytes)) 'outside publish has exact input bytes'
        $outsideSnapshot = Request 'snapshot' $bypass.remotePath
        $outsideSnapshot.bypassRoot = $true
        $result = Call $outsideSnapshot
        Assert-True ($result.exitCode -eq 0 -and $result.data.sha256 -ceq $script:digest -and $result.data.rootPolicyApplied -ceq 'test-server-bypass') 'bypass snapshots outside configured root'
        foreach ($id in @($bypass.id, $outsideSnapshot.id)) {
            $cleanup = Request 'cleanup'
            $cleanup.id = $id
            $result = Call $cleanup
            Assert-True ($result.exitCode -eq 0 -and $result.data.cleaned) 'normal cleanup works without configured destination root'
            Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($id + '.part')))) 'cleanup removes stage with unavailable destination root'
        }
    } finally { [IO.Directory]::Move($parkedRoot, $root) }

    # A shared drop directory permits other users to create names. Handle-relative
    # creation and a private file DACL preserve those rights without inheriting them.
    $effectiveDirectory = Join-Path $WorkRoot 'writer-effective-create'
    $null = [IO.Directory]::CreateDirectory($effectiveDirectory)
    $effectiveAcl = Get-Acl -LiteralPath $effectiveDirectory
    $effectiveAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories),
        [Security.AccessControl.AccessControlType]::Allow))
    $effectiveAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $effectiveDirectory -AclObject $effectiveAcl
    $effectiveSddl = (Get-Acl -LiteralPath $effectiveDirectory).Sddl
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([string]$effectiveSddl)
    Assert-True (@($descriptor.DiscretionaryAcl | Where-Object {
        $_ -is [Security.AccessControl.QualifiedAce] -and $_.SecurityIdentifier.Value -ceq 'S-1-5-32-545' -and
        (([int]$_.AceFlags -band 8) -eq 0) -and (([int]$_.AccessMask -band 6) -eq 6)
    }).Count -gt 0) 'WRITER-ACL-02 fixture has effective Users create rights'
    $effectiveRequest = Request 'publish' (Join-Path $effectiveDirectory 'private.bin')
    $effectiveRequest.bypassRoot = $true
    Stage $effectiveRequest
    $effectiveResult = Call $effectiveRequest
    Assert-True ($effectiveResult.exitCode -eq 0 -and $effectiveResult.data.published) ('WRITER-ACL-02 shared create-only parent permits publish; ' + (Describe-Result $effectiveResult))
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($effectiveRequest.remotePath)) -ceq [Convert]::ToBase64String($script:bytes)) 'WRITER-ACL-02 binary bytes are exact'
    Assert-PrivateFile $effectiveRequest.remotePath $sid
    $effectiveSnapshot = Request 'snapshot' $effectiveRequest.remotePath
    $effectiveSnapshot.bypassRoot = $true
    $effectiveResult = Call $effectiveSnapshot
    Assert-True ($effectiveResult.exitCode -eq 0 -and $effectiveResult.data.sha256 -ceq $script:digest) 'WRITER-ACL-02 shared parent permits snapshot of the pinned regular file'
    Assert-True ((Get-Acl -LiteralPath $effectiveDirectory).Sddl -ceq $effectiveSddl) 'WRITER-ACL-02 directory ACL stays unchanged'
    foreach ($id in @($effectiveRequest.id, $effectiveSnapshot.id)) {
        $cleanup = Request 'cleanup'
        $cleanup.id = $id
        Assert-True ((Call $cleanup).exitCode -eq 0) 'WRITER-ACL-02 stage is cleaned'
    }

    $inheritParent = Join-Path $WorkRoot 'writer-inheritance-parent'
    $null = [IO.Directory]::CreateDirectory($inheritParent)
    $inheritAcl = Get-Acl -LiteralPath $inheritParent
    $inheritAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories),
        [Security.AccessControl.InheritanceFlags]::ContainerInherit,
        [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $inheritParent -AclObject $inheritAcl
    $inheritChild = Join-Path $inheritParent 'child'
    $null = [IO.Directory]::CreateDirectory($inheritChild)
    $childSddl = (Get-Acl -LiteralPath $inheritChild).Sddl
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new([string]$childSddl)
    Assert-True (@($descriptor.DiscretionaryAcl | Where-Object {
        $_ -is [Security.AccessControl.QualifiedAce] -and $_.SecurityIdentifier.Value -ceq 'S-1-5-32-545' -and
        (([int]$_.AceFlags -band 16) -ne 0) -and (([int]$_.AceFlags -band 8) -eq 0) -and (([int]$_.AccessMask -band 6) -eq 6)
    }).Count -gt 0) 'WRITER-ACL-03 child inherited Users ACE is effective, not inherit-only'
    $childRequest = Request 'publish' (Join-Path $inheritChild 'private.bin')
    $childRequest.bypassRoot = $true
    Stage $childRequest
    $childResult = Call $childRequest
    Assert-True ($childResult.exitCode -eq 0 -and $childResult.data.published) ('WRITER-ACL-03 inherited create rights permit private publish; ' + (Describe-Result $childResult))
    Assert-PrivateFile $childRequest.remotePath $sid
    Assert-True ((Get-Acl -LiteralPath $inheritChild).Sddl -ceq $childSddl) 'WRITER-ACL-03 inherited directory ACL is unchanged'
    $cleanup = Request 'cleanup'
    $cleanup.id = $childRequest.id
    Assert-True ((Call $cleanup).exitCode -eq 0) 'WRITER-ACL-03 stage is cleaned'

    $deniedDirectory = Join-Path $WorkRoot 'denied-destination'
    $null = [IO.Directory]::CreateDirectory($deniedDirectory)
    $deniedAcl = Get-Acl -LiteralPath $deniedDirectory
    $restoreAcl = Get-Acl -LiteralPath $deniedDirectory
    $deniedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::CreateFiles, [Security.AccessControl.AccessControlType]::Deny))
    try {
        Set-Acl -LiteralPath $deniedDirectory -AclObject $deniedAcl
        $deniedSddl = (Get-Acl -LiteralPath $deniedDirectory).Sddl
        $deniedRequest = Request 'publish' (Join-Path $deniedDirectory 'must-not-exist.bin')
        $deniedRequest.bypassRoot = $true
        Stage $deniedRequest
        $deniedResult = Call $deniedRequest
        Assert-True ($deniedResult.exitCode -eq 1 -and $deniedResult.data.errorCode -ceq 'PERMISSION_DENIED' -and
            $deniedResult.data.nativeStep -ceq 'open' -and $deniedResult.data.nativeError -eq 5) 'bypass retains actual destination OS write denial'
        Assert-True ($deniedResult.data.origin -ceq 'os' -and !$deniedResult.data.PSObject.Properties['policyReason']) 'WRITER-ACL-04 actual OS open denial is distinct from policy refusal'
        Assert-True (!$deniedResult.data.published -and !(Test-Path -LiteralPath $deniedRequest.remotePath)) 'permission denial cannot report or create published destination'
        Assert-True ((Get-Acl -LiteralPath $deniedDirectory).Sddl -ceq $deniedSddl) 'bypass never repairs destination directory permissions'
        $cleanup = Request 'cleanup'
        $cleanup.id = $deniedRequest.id
        Assert-True ((Call $cleanup).exitCode -eq 0) 'permission-denied publish can clean its stage'
    } finally { Set-Acl -LiteralPath $deniedDirectory -AclObject $restoreAcl }

    foreach ($flag in @($false, $true)) {
        $raceDirectory = if ($flag) { $bypassDirectory } else { $root }
        $racePath = Join-Path $raceDirectory 'race.bin'
        $first = Request 'publish' $racePath
        $second = Request 'publish' $racePath
        $first.bypassRoot = $flag
        $second.bypassRoot = $flag
        Stage $first
        Stage $second
        $one = Start-Script $script:helper '' ($first | ConvertTo-Json -Compress)
        $two = Start-Script $script:helper '' ($second | ConvertTo-Json -Compress)
        $results = @((Complete-Script $one), (Complete-Script $two))
        Assert-True (@($results | Where-Object { $_.exitCode -eq 0 -and $_.data.published }).Count -eq 1) 'concurrent new publish has exactly one winner with either root policy'
        Assert-True (@($results | Where-Object { $_.exitCode -eq 1 -and $_.data.errorCode -ceq 'DESTINATION_EXISTS' }).Count -eq 1) 'concurrent publish loser cannot overwrite with either root policy'
    }
    $locked = [IO.File]::Open($script:target, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try { Refused (Request 'snapshot') 'PERMISSION_DENIED' } finally { $locked.Dispose() }

    foreach ($path in @('relative.txt', '\\server\share\file', '\\?\C:\file', 'C:relative', 'C:\file:stream',
        ($root + '\..\escape'), ($root + '\.\file'), ($root + '\a\\b'), ($root + '\NUL.txt'),
        ($root + '\COM1'), ($root + '\name.'), ($root + '\name '), ($root + '\folder\'))) {
        foreach ($flag in @($false, $true)) {
            $unsafe = Request 'snapshot' $path
            $unsafe.bypassRoot = $flag
            Refused $unsafe 'UNSAFE_PATH'
        }
    }
    $invalid = Request
    $invalid.id = '../sensitive-marker'
    Refused $invalid 'INVALID_REQUEST'
    $invalid = Request
    $invalid.overwrite = 'true'
    Refused $invalid 'INVALID_REQUEST'
    $invalid = Request
    $invalid.elevate = 'true'
    Refused $invalid 'INVALID_REQUEST'
    $invalid = Request
    $invalid.bypassRoot = 'true'
    Refused $invalid 'INVALID_REQUEST'
    Refused (Request 'authorize') 'INVALID_REQUEST'
    $invalid = Request
    $invalid.maxBytes = 1.5
    Refused $invalid 'INVALID_REQUEST'
    $result = Invoke-Script $script:helper '' ('x' * 16385)
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'INVALID_REQUEST') 'bounded input'
    $boundary = Request 'cleanup'
    $boundary.padding = ''
    $boundaryLength = [Text.Encoding]::UTF8.GetByteCount(($boundary | ConvertTo-Json -Compress))
    $boundary.padding = 'a' * (16384 - $boundaryLength)
    Assert-True ([Text.Encoding]::UTF8.GetByteCount(($boundary | ConvertTo-Json -Compress)) -eq 16384) 'boundary fixture has exactly the maximum input byte count'
    Assert-True ((Call $boundary).exitCode -eq 0) 'exact maximum metadata is accepted after EOF'
    $trailing = ($boundary | ConvertTo-Json -Compress) + ' '
    $result = Invoke-Script $script:helper '' $trailing
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'INVALID_REQUEST') 'one byte beyond the limit is refused'
    $trailing = (Request | ConvertTo-Json -Compress) + 'x'
    $result = Invoke-Script $script:helper '' $trailing
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'INVALID_REQUEST') 'trailing bytes after JSON are refused'
    $invalidBytes = [byte[]]@(0xc3, 0x28)
    $result = Complete-Script (Start-Script $script:helper '' '' $invalidBytes)
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'INVALID_REQUEST') 'malformed UTF8 is refused before JSON parsing'
    $oversized = Request
    $oversized.padding = [string]::new([char]0xd55c, 6000)
    $oversizedJson = $oversized | ConvertTo-Json -Compress
    Assert-True ($oversizedJson.Length -lt 16385 -and [Text.Encoding]::UTF8.GetByteCount($oversizedJson) -gt 16384) 'multibyte fixture isolates the byte bound from the character bound'
    Refused $oversized 'INVALID_REQUEST'

    $originalParentAcl = Get-Acl -LiteralPath $WorkRoot
    $weakenedParentAcl = Get-Acl -LiteralPath $WorkRoot
    $weakenedParentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.AccessControlType]::Allow))
    try {
        Set-Acl -LiteralPath $WorkRoot -AclObject $weakenedParentAcl
        Refused (Request 'snapshot') 'PERMISSION_DENIED'
    } finally { Set-Acl -LiteralPath $WorkRoot -AclObject $originalParentAcl }

    $outside = Join-Path $WorkRoot 'outside'
    $null = [IO.Directory]::CreateDirectory($outside)
    [IO.File]::WriteAllBytes((Join-Path $outside 'secret.bin'), $script:bytes)
    $junction = Join-Path $root 'junction'
    $null = New-Item -ItemType Junction -Path $junction -Target $outside
    Refused (Request 'snapshot' (Join-Path $junction 'secret.bin')) 'UNSAFE_PATH'
    $hardlink = Join-Path $root 'hardlink.bin'
    $null = New-Item -ItemType HardLink -Path $hardlink -Target (Join-Path $outside 'secret.bin')
    Refused (Request 'snapshot' $hardlink) 'UNSAFE_PATH'
    $symlink = Join-Path $root 'symlink.bin'
    $null = New-Item -ItemType SymbolicLink -Path $symlink -Target (Join-Path $outside 'secret.bin')
    Refused (Request 'snapshot' $symlink) 'UNSAFE_PATH'
    foreach ($path in @((Join-Path $junction 'secret.bin'), $hardlink, $symlink)) {
        $unsafe = Request 'snapshot' $path
        $unsafe.bypassRoot = $true
        Refused $unsafe 'UNSAFE_PATH'
    }
    $badStage = Request 'cleanup'
    $null = New-Item -ItemType SymbolicLink -Path (Join-Path $script:stage ($badStage.id + '.part')) -Target (Join-Path $outside 'secret.bin')
    Refused $badStage 'UNSAFE_PATH'
    Assert-True (Test-Path -LiteralPath (Join-Path $outside 'secret.bin')) 'unsafe cleanup cannot touch target'
    [Console]::Out.WriteLine((@{ passed = $passed } | ConvertTo-Json -Compress))
    exit 0
} catch {
    # Fixture assertion labels contain no request or file bytes.
    [Console]::Error.WriteLine('Windows helper verification failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($fixtureCreated) {
        $resolvedFixture = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
        if (!$resolvedFixture.Equals($fixturePath, [StringComparison]::OrdinalIgnoreCase) -or
            ![IO.Path]::GetDirectoryName($resolvedFixture).Equals($fixtureParent, [StringComparison]::OrdinalIgnoreCase) -or
            $resolvedFixture.Equals([IO.Path]::GetPathRoot($resolvedFixture).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture cleanup boundary mismatch' }
        Remove-FixtureEntry ([IO.DirectoryInfo]::new($resolvedFixture))
    }
}
