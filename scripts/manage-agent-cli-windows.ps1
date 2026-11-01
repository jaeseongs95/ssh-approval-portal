# Fixed server-owned helper. Arguments arrive only through the verified transport.
param([string[]]$CliArguments)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
foreach ($moduleName in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security')) {
    Microsoft.PowerShell.Core\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules',$moduleName,($moduleName+'.psd1'))) -Force -ErrorAction Stop
}
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$versionPattern = '(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$accountSid = $identity.User.Value
$homeDirectory = [Environment]::GetFolderPath('UserProfile')
$packages = @{ codex = '@openai/codex'; claude = '@anthropic-ai/claude-code' }
function Require($condition, [string]$code) { if (-not $condition) { throw $code } }
function Json($value) { ConvertTo-Json -InputObject $value -Depth 16 -Compress }
function HashBytes([byte[]]$bytes, [string]$algorithm = 'SHA256') {
    $hash = [Security.Cryptography.HashAlgorithm]::Create($algorithm)
    try { ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
}
function Digest($value) { HashBytes ($utf8.GetBytes((Json $value) + "`n")) }
function Trusted([string]$path, [bool]$private = $false) {
    $item = Get-Item -LiteralPath $path -Force
    Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'UNSAFE_PATH'
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $trustedOwners = @($accountSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    Require ($owner -in $trustedOwners -and (-not $private -or $owner -eq $accountSid)) 'UNSAFE_PATH'
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($private -or ($rule.FileSystemRights -band $writeMask) -ne 0)) {
            Require ($rule.IdentityReference.Value -in $trustedOwners) 'UNSAFE_PATH'
        }
    }
    return $item
}
function TrustedChain([string]$path) {
    $entry = [IO.Path]::GetFullPath($path)
    while ($entry -and $entry -ne [IO.Path]::GetPathRoot($entry)) {
        $null = Trusted $entry
        if ($entry -eq $homeDirectory) { break }
        $entry = [IO.Path]::GetDirectoryName($entry)
    }
}
function PrivateDirectory([string]$path) {
    if (-not [IO.Directory]::Exists($path)) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $sid = [Security.Principal.SecurityIdentifier]::new($accountSid)
        $acl.SetOwner($sid)
        foreach ($value in @($accountSid, 'S-1-5-18', 'S-1-5-32-544')) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        $null = [IO.Directory]::CreateDirectory($path, $acl)
    }
    $item = Trusted $path $true
    Require $item.PSIsContainer 'UNSAFE_DIRECTORY'
}
function ReadJson([string]$path) {
    $item = Trusted $path $true
    Require (-not $item.PSIsContainer -and $item.Length -le 16384) 'INVALID_STATE'
    $value = $utf8.GetString([IO.File]::ReadAllBytes($path)) | ConvertFrom-Json
    Require ($value -is [pscustomobject]) 'INVALID_STATE'
    return $value
}
function NewPrivateFile([string]$path) {
    $acl=[Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($accountSid))
    foreach ($value in @($accountSid,'S-1-5-18','S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value),'FullControl','Allow'))
    }
    # CreateNew preserves the no-overwrite boundary; an elevated token's default
    # Administrators owner must not replace the selected account's explicit owner.
    return [IO.FileStream]::new($path,[IO.FileMode]::CreateNew,([Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write),[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl)
}
function AtomicJson([string]$path, $value) {
    if (Test-Path -LiteralPath $path) { $null = Trusted $path $true }
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($path)) ('.state-' + [Guid]::NewGuid().ToString('N'))
    $stream = NewPrivateFile $temporary
    try { $bytes = $utf8.GetBytes((Json $value) + "`n"); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($path)) { [AgentCliState]::Replace($temporary, $path) } else { [IO.File]::Move($temporary, $path) }
}
function RemovePrivateEntry([string]$path, [string]$boundary) {
    $resolved=[IO.Path]::GetFullPath($path); $base=[IO.Path]::GetFullPath($boundary).TrimEnd('\')+'\'
    Require ($resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) 'UNSAFE_CLEANUP'
    try {
        $item=Trusted $resolved $true
        $failures=0
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $resolved -Force) { $failures += RemovePrivateEntry $child.FullName $boundary }
            if ($failures -eq 0) { [IO.Directory]::Delete($resolved,$false) }
        } else { [IO.File]::Delete($resolved) }
        return $failures
    } catch { return 1 }
}
function Cleanup([string]$root,[string]$work,[string[]]$keepVersions) {
    $failures=0
    foreach ($item in Get-ChildItem -LiteralPath $work -Force) {
        if ($item.Name -cne 'receipt.json') { $failures += RemovePrivateEntry $item.FullName $work }
    }
    $versions=Join-Path $root 'versions'
    foreach ($item in Get-ChildItem -LiteralPath $versions -Force) {
        if ($item.Name -cnotin $keepVersions) { $failures += RemovePrivateEntry $item.FullName $versions }
    }
    return $failures
}

# A job closes the complete process tree on timeout/output overflow, including npm children.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AgentCliState {
 // Keep the backup argument a real CLR null: PowerShell 5.1 converts an untyped
 // $null string argument to an empty path before invoking File.Replace.
 public static void Replace(string source,string destination) { File.Replace(source,destination,null); }
}
public static class AgentCliProcess {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public Io io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public int size; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
  public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct StartupExtended { public Startup startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process,thread; public uint processId,threadId; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string b);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr a,int b,ref Extended c,uint d);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr a,IntPtr b);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr a);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Attributes attributes,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref Attributes attributes,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returnedSize);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupExtended startup,out ProcessInformation process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 public static string Quote(string s) {
  var result=new StringBuilder("\""); int slashes=0;
  foreach(char c in s) { if(c=='\\') { slashes++; continue; } if(c=='"') { result.Append('\\',slashes*2+1); result.Append(c); } else { result.Append('\\',slashes); result.Append(c); } slashes=0; }
  result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
 }
 public static object[] Run(string exe,string[] args,string cwd,string[] environment,int timeout,int limit) {
  if(timeout<=0||limit<=0||!Path.IsPathRooted(exe)||!Path.IsPathRooted(cwd)) throw new Exception("PROCESS_FAILED");
  IntPtr job=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero;
  IntPtr attributeList=IntPtr.Zero,handleList=IntPtr.Zero,environmentBlock=IntPtr.Zero;
  var process=new ProcessInformation(); bool assigned=false,attributesReady=false;
  FileStream stdout=null,stderr=null; Thread a=null,bthread=null;
  using(var output=new MemoryStream()) using(var error=new MemoryStream()) {
   int overflow=0,count=0;
   try {
    job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("PROCESS_FAILED");
    var limits=new Extended(); limits.basic.flags=0x2000;
    if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Exception("PROCESS_FAILED");
    var security=new Attributes(); security.length=Marshal.SizeOf(security); security.inherit=true;
    if(!CreatePipe(out outRead,out outWrite,ref security,0)||!CreatePipe(out errRead,out errWrite,ref security,0)
       ||!SetHandleInformation(outRead,1,0)||!SetHandleInformation(errRead,1,0)) throw new Exception("PROCESS_FAILED");
    input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
    if(input==new IntPtr(-1)) { input=IntPtr.Zero; throw new Exception("PROCESS_FAILED"); }
    IntPtr attributeBytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeBytes);
    if(attributeBytes.ToInt64()<=0||attributeBytes.ToInt64()>65536) throw new Exception("PROCESS_FAILED");
    attributeList=Marshal.AllocHGlobal(attributeBytes);
    if(!InitializeProcThreadAttributeList(attributeList,1,0,ref attributeBytes)) throw new Exception("PROCESS_FAILED");
    attributesReady=true; handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
    Marshal.WriteIntPtr(handleList,0,input); Marshal.WriteIntPtr(handleList,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errWrite);
    if(!UpdateProcThreadAttribute(attributeList,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw new Exception("PROCESS_FAILED");
    var variables=(string[])environment.Clone(); Array.Sort(variables,StringComparer.OrdinalIgnoreCase);
    foreach(var variable in variables) if(variable.IndexOf('=')<=0||variable.IndexOf('\0')>=0) throw new Exception("PROCESS_FAILED");
    environmentBlock=Marshal.StringToHGlobalUni(String.Join("\0",variables)+"\0\0");
    var startup=new StartupExtended(); startup.startup.size=Marshal.SizeOf(startup); startup.startup.flags=0x100;
    startup.startup.input=input; startup.startup.output=outWrite; startup.startup.error=errWrite; startup.attributes=attributeList;
    var command=new StringBuilder(Quote(exe)+" "+String.Join(" ",Array.ConvertAll(args,Quote)));
    // No program instruction runs before the job owns the suspended process.
    const uint createSuspended=0x4,unicodeEnvironment=0x400,extendedStartup=0x80000,noWindow=0x08000000;
    if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,createSuspended|unicodeEnvironment|extendedStartup|noWindow,environmentBlock,cwd,ref startup,out process)) throw new Exception("PROCESS_FAILED");
    if(!AssignProcessToJobObject(job,process.process)) throw new Exception("PROCESS_FAILED");
    assigned=true;
    if(ResumeThread(process.thread)==UInt32.MaxValue) throw new Exception("PROCESS_FAILED");
    CloseHandle(process.thread); process.thread=IntPtr.Zero;
    CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero; CloseHandle(input); input=IntPtr.Zero;
    stdout=new FileStream(new SafeFileHandle(outRead,true),FileAccess.Read); outRead=IntPtr.Zero;
    stderr=new FileStream(new SafeFileHandle(errRead,true),FileAccess.Read); errRead=IntPtr.Zero;
    ThreadStart readOut=()=>{ try { int value; while((value=stdout.ReadByte())>=0) { if(Interlocked.Increment(ref count)>limit) { Interlocked.Exchange(ref overflow,1); break; } output.WriteByte((byte)value); } } catch { Interlocked.Exchange(ref overflow,1); } };
    ThreadStart readErr=()=>{ try { int value; while((value=stderr.ReadByte())>=0) { if(Interlocked.Increment(ref count)>limit) { Interlocked.Exchange(ref overflow,1); break; } error.WriteByte((byte)value); } } catch { Interlocked.Exchange(ref overflow,1); } };
    a=new Thread(readOut); bthread=new Thread(readErr); a.IsBackground=bthread.IsBackground=true; a.Start(); bthread.Start();
    var watch=Stopwatch.StartNew();
    while(true) {
     uint state=WaitForSingleObject(process.process,25); if(state==0) break; if(state!=258) throw new Exception("PROCESS_FAILED");
     if(overflow!=0) throw new Exception("OUTPUT_LIMIT"); if(watch.ElapsedMilliseconds>=timeout) throw new Exception("PROCESS_TIMEOUT");
    }
    if(!a.Join(Math.Max(1,timeout-(int)watch.ElapsedMilliseconds))||!bthread.Join(Math.Max(1,timeout-(int)watch.ElapsedMilliseconds))) throw new Exception("PROCESS_TIMEOUT");
    if(overflow!=0) throw new Exception("OUTPUT_LIMIT"); uint code;
    if(!GetExitCodeProcess(process.process,out code)) throw new Exception("PROCESS_FAILED");
    return new object[]{unchecked((int)code),new UTF8Encoding(false,true).GetString(output.ToArray()),new UTF8Encoding(false,true).GetString(error.ToArray())};
   } finally {
    if(process.process!=IntPtr.Zero&&!assigned) { TerminateProcess(process.process,125); WaitForSingleObject(process.process,5000); }
    if(job!=IntPtr.Zero) CloseHandle(job);
    if(stdout!=null) stdout.Dispose(); if(stderr!=null) stderr.Dispose();
    if(a!=null&&a.IsAlive) a.Join(5000); if(bthread!=null&&bthread.IsAlive) bthread.Join(5000);
    foreach(var handle in new IntPtr[]{outRead,outWrite,errRead,errWrite,input,process.thread,process.process}) if(handle!=IntPtr.Zero) CloseHandle(handle);
    if(attributesReady) DeleteProcThreadAttributeList(attributeList);
    if(attributeList!=IntPtr.Zero) Marshal.FreeHGlobal(attributeList); if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
    if(environmentBlock!=IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
   }
  }
 }
}
'@ | Out-Null
function EnvironmentFor([string]$homePath, [string]$nodeDirectory = '', [bool]$login = $false, [string]$temporaryDirectory = '') {
    $system = [Environment]::GetFolderPath('System')
    if (-not $temporaryDirectory) { $temporaryDirectory = $homePath }
    $values = @(('SystemRoot=' + [IO.Directory]::GetParent($system).FullName), ('WINDIR=' + [IO.Directory]::GetParent($system).FullName),
        ('COMSPEC=' + (Join-Path $system 'cmd.exe')), ('PATH=' + $nodeDirectory + ';' + $system),
        ('USERPROFILE=' + $homePath), ('HOME=' + $homePath), ('APPDATA=' + (Join-Path $homePath 'AppData\Roaming')),
        ('LOCALAPPDATA=' + (Join-Path $homePath 'AppData\Local')), ('TEMP=' + $temporaryDirectory), ('TMP=' + $temporaryDirectory),
        'DISABLE_UPDATES=1', 'DISABLE_AUTOUPDATER=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1')
    if (-not $login) { $values += @(('CODEX_HOME=' + (Join-Path $homePath 'codex')), ('CLAUDE_CONFIG_DIR=' + (Join-Path $homePath 'claude'))) }
    return $values
}
function NodeRuntime {
    $candidates = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $homeDirectory 'AppData\Local\Programs\nodejs\node.exe'))
    foreach ($directory in ($env:PATH -split ';')) {
        if ($directory -and [IO.Path]::IsPathRooted($directory)) { $candidates += Join-Path $directory 'node.exe' }
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if ([IO.File]::Exists($candidate)) {
            TrustedChain $candidate
            $npm = Join-Path ([IO.Path]::GetDirectoryName($candidate)) 'node_modules\npm\bin\npm-cli.js'
            if ([IO.File]::Exists($npm)) { TrustedChain $npm; return @($candidate, $npm) }
        }
    }
    throw 'NODE_NPM_REQUIRED'
}
function PackageExecutable([string]$prefix, [string]$provider) {
    $packageRoot = Join-Path $prefix ('node_modules\' + $packages[$provider].Replace('/', '\'))
    $metadataPath = Join-Path $packageRoot 'package.json'
    TrustedChain $metadataPath
    Require ((Get-Item -LiteralPath $metadataPath).Length -le 1048576) 'INVALID_INSTALLATION'
    $metadata = $utf8.GetString([IO.File]::ReadAllBytes($metadataPath)) | ConvertFrom-Json
    $relative = if ($metadata.bin -is [string]) { $metadata.bin } else { $metadata.bin.$provider }
    Require ($relative -is [string] -and -not [IO.Path]::IsPathRooted($relative)) 'INVALID_INSTALLATION'
    $binary = [IO.Path]::GetFullPath((Join-Path $packageRoot $relative))
    Require ($binary.StartsWith($packageRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetExtension($binary) -in @('.js', '.exe', '.cjs', '.mjs')) 'INVALID_INSTALLATION'
    TrustedChain $binary
    return $binary
}
function RunCli([string]$binary, [string[]]$arguments, [string]$cwd, [bool]$login = $false) {
    $nodeDirectory = ''
    if ([IO.Path]::GetExtension($binary) -ne '.exe') { $runtime = NodeRuntime; $nodeDirectory = [IO.Path]::GetDirectoryName($runtime[0]); $arguments = @($binary) + $arguments; $binary = $runtime[0] }
    # A CLI may reject its persistent home below TEMP. Keep temporary files in
    # the private invocation directory without changing the real login home.
    $temporaryDirectory = Join-Path $cwd 'tmp'; PrivateDirectory $temporaryDirectory
    return [AgentCliProcess]::Run($binary, $arguments, $cwd, (EnvironmentFor $(if ($login) { $homeDirectory } else { $cwd }) $nodeDirectory $login $temporaryDirectory), 15000, 8192)
}
function VersionOf([string]$binary, [string]$provider) {
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('ssh-cli-version-' + [Guid]::NewGuid().ToString('N'))
    PrivateDirectory $directory
    try {
        $result = RunCli $binary @('--version') $directory
        $pattern = if ($provider -eq 'codex') { '^codex-cli (' + $versionPattern + ')$' } else { '^(' + $versionPattern + ') \(Claude Code\)$' }
        Require ($result[0] -eq 0 -and $result[1].Length -le 256 -and $result[1].Trim() -cmatch $pattern) 'VERSION_UNAVAILABLE'
        return $Matches[1]
    } finally { Remove-Item -LiteralPath $directory -Recurse -Force }
}
function FileHash([string]$path) {
    $null = Trusted $path
    Require ((Get-Item -LiteralPath $path).Length -le 536870912) 'EXECUTABLE_TOO_LARGE'
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Inspect([string]$root, [string]$provider) {
    TrustedChain $homeDirectory
    $state = [ordered]@{ provider=$provider; managed=$false; installed=$false; version=$null; active=$null; login='not_checked' }
    if (Test-Path -LiteralPath $root) { TrustedChain $root; $null = Trusted $root $true }
    $current = Join-Path $root 'current.json'
    if (Test-Path -LiteralPath $current) {
        $target = (ReadJson $current).active
        Require ($target -is [string] -and $target -cmatch ('^versions/(' + $versionPattern + ')-[a-f0-9]{16}$')) 'INVALID_STATE'
        $prefix = Join-Path $root $target
        $metadata = ReadJson (Join-Path $prefix '.installed.json')
        Require (($metadata.PSObject.Properties.Name | Sort-Object) -join ',' -ceq 'executableSha256,integrity,provider,version') 'INVALID_STATE'
        Require ($metadata.provider -ceq $provider -and $metadata.version -cmatch ('^' + $versionPattern + '$') -and $metadata.integrity -cmatch '^sha512-[A-Za-z0-9+/]{86}==$' -and $metadata.executableSha256 -cmatch '^[a-f0-9]{64}$') 'INVALID_STATE'
        Require ($target -ceq ('versions/' + $metadata.version + '-' + (HashBytes ($utf8.GetBytes($metadata.integrity))).Substring(0,16))) 'INVALID_STATE'
        $binary = PackageExecutable $prefix $provider
        Require ((FileHash $binary) -ceq $metadata.executableSha256) 'INSTALLED_FILE_CHANGED'
        $state.managed=$true; $state.installed=$true; $state.version=$metadata.version; $state.active=$target
    } else {
        $prefixes = @((Join-Path $homeDirectory 'AppData\Roaming\npm'), (Join-Path $env:ProgramFiles 'nodejs'))
        foreach ($prefix in $prefixes) {
            $metadataPath = Join-Path $prefix ('node_modules\' + $packages[$provider].Replace('/', '\') + '\package.json')
            if ([IO.File]::Exists($metadataPath)) {
                $binary = PackageExecutable $prefix $provider
                $state.installed=$true; $state.active=$binary.Replace('\','/'); try { $state.version=VersionOf $binary $provider } catch { $state.version=$null }
                $state.Add('externalIdentity', (FileHash $binary)); break
            }
        }
        if (-not $state.installed) {
            $candidates = @((Join-Path $homeDirectory ('.local\bin\' + $provider + '.exe')))
            foreach ($directory in ($env:PATH -split ';')) { if ($directory -and [IO.Path]::IsPathRooted($directory)) { $candidates += Join-Path $directory ($provider + '.exe') } }
            foreach ($candidate in ($candidates | Select-Object -Unique)) {
                if ([IO.File]::Exists($candidate)) {
                    TrustedChain $candidate
                    $state.installed=$true; $state.active=$candidate.Replace('\','/'); try { $state.version=VersionOf $candidate $provider } catch { $state.version=$null }
                    $state.Add('externalIdentity', (FileHash $candidate)); break
                }
            }
        }
    }
    # Sort keys exactly as the other helper's canonical JSON digest.
    $canonical = [ordered]@{}; foreach ($key in ($state.Keys | Sort-Object -CaseSensitive)) { $canonical[$key] = $state[$key] }
    $state.Add('installationRevision', (Digest $canonical))
    return $state
}
function Status([string]$root, [string]$provider, [string]$operation) {
    Require ($operation -cmatch '^[a-f0-9]{48}$') 'INVALID_PLAN'
    $null = Inspect $root $provider
    $work = Join-Path $root ('operations\' + $operation)
    if (-not (Test-Path -LiteralPath $work)) { return @{state='not_found';operationId=$operation} }
    TrustedChain $work
    $receipt = ReadJson (Join-Path $work 'receipt.json')
    Require ($receipt.provider -ceq $provider -and $receipt.operationId -ceq $operation -and $receipt.intentDigest -cmatch '^[a-f0-9]{64}$' -and $receipt.version -cmatch ('^' + $versionPattern + '$') -and $receipt.login -ceq 'not_checked' -and $receipt.state -cin @('preparing','installing','completed','reused','failed')) 'INVALID_STATE'
    if ($receipt.state -cin @('preparing','installing')) {
        try { $lock = [IO.File]::Open((Join-Path $root '.lock'), 'Open', 'ReadWrite', 'None'); $lock.Dispose(); $receipt.state='unknown' }
        catch [IO.IOException] { $receipt.state='unknown' }
        # A read-only lookup cannot prove which live process holds an exclusive handle.
    }
    if ($null -ne $receipt.PSObject.Properties['error']) { $receipt.error='INSTALL_FAILED' }
    return $receipt
}
function Download([string]$url, [string]$destination, [long]$deadline) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($url); $request.AllowAutoRedirect=$false
    $request.Timeout=30000; $request.ReadWriteTimeout=30000
    $response=$request.GetResponse()
    try {
        Require ([int]$response.StatusCode -eq 200 -and $response.ContentLength -le 33554432) 'DOWNLOAD_FAILED'
        $input=$response.GetResponseStream(); $output=[IO.File]::Open($destination,'CreateNew','Write','None')
        try { $buffer=New-Object byte[] 65536; $total=0L
            while (($count=$input.Read($buffer,0,$buffer.Length)) -gt 0) {
                $total += $count; Require ($total -le 33554432) 'PACKAGE_TOO_LARGE'
                Require ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) 'PLAN_EXPIRED'
                $output.Write($buffer,0,$count)
            }
            $output.Flush($true)
        } finally { $input.Dispose(); $output.Dispose() }
    } finally { $response.Dispose() }
}
function Install([string]$root, [string]$action, [string]$provider, [string]$version, [string]$integrity, [string]$expected, [long]$expires, [string]$operation) {
    Require ($version -cmatch ('^' + $versionPattern + '$') -and $expected -cmatch '^[a-f0-9]{64}$' -and $operation -cmatch '^[a-f0-9]{48}$') 'INVALID_PLAN'
    Require ($integrity -cmatch '^sha512-[A-Za-z0-9+/]{86}==$') 'INVALID_INTEGRITY'
    Require ([Convert]::ToBase64String([Convert]::FromBase64String($integrity.Substring(7))) -ceq $integrity.Substring(7)) 'INVALID_INTEGRITY'
    Require ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $expires) 'PLAN_EXPIRED'
    # Match ordinal JSON key order: expected sorts before expires.
    $intent = [ordered]@{action=$action;expected=$expected;expires=$expires;integrity=$integrity;provider=$provider;version=$version}
    $digest = Digest $intent
    $null = Trusted $homeDirectory
    foreach ($directory in @((Join-Path $homeDirectory '.ssh-approval-cli'),$root,(Join-Path $root 'versions'),(Join-Path $root 'operations'))) { PrivateDirectory $directory }
    $lockPath=Join-Path $root '.lock'
    if (Test-Path -LiteralPath $lockPath) {
        $null=Trusted $lockPath $true
        try { $lock=[IO.File]::Open($lockPath,'Open','ReadWrite','None') } catch { throw 'BUSY' }
    } else {
        try { $lock=NewPrivateFile $lockPath } catch { throw 'BUSY' }
    }
    try {
        $lock.SetLength(0); $bytes=$utf8.GetBytes($operation); $lock.Write($bytes,0,$bytes.Length); $lock.Flush($true)
        $work=Join-Path $root ('operations\' + $operation)
        if (Test-Path -LiteralPath $work) {
            $saved=ReadJson (Join-Path $work 'receipt.json')
            Require ($saved.intentDigest -ceq $digest) 'REQUEST_CONFLICT'
            Require ($saved.state -cin @('completed','reused')) 'RESULT_UNKNOWN'
            return $saved
        }
        $before=Inspect $root $provider
        Require ($before.installationRevision -ceq $expected) 'STALE_INSTALLATION'
        Require ($action -ne 'update' -or $before.managed) 'MANAGED_UPDATE_REQUIRED'
        PrivateDirectory $work
        $receipt=[ordered]@{provider=$provider;operationId=$operation;intentDigest=$digest;state='preparing';version=$version;login='not_checked'}
        $receiptPath=Join-Path $work 'receipt.json'; AtomicJson $receiptPath $receipt
        if ($before.installed -and $before.version -ceq $version) {
            if ($before.managed) { Require ((ReadJson (Join-Path (Join-Path $root $before.active) '.installed.json')).integrity -ceq $integrity) 'INSTALLED_RELEASE_CHANGED' }
            $receipt.state='reused'; AtomicJson $receiptPath $receipt; return $receipt
        }
        $switched=$false; $prior=$before.active; $target=$null
        try {
            $runtime=NodeRuntime; $nodeDirectory=[IO.Path]::GetDirectoryName($runtime[0]); PrivateDirectory (Join-Path $work 'home')
            $nodeResult=[AgentCliProcess]::Run($runtime[0],@('--version'),$work,(EnvironmentFor (Join-Path $work 'home') $nodeDirectory),10000,256)
            Require ($nodeResult[0] -eq 0 -and $nodeResult[1] -cmatch '^v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+\s*$') 'NODE22_REQUIRED'
            $package=Join-Path $work 'package.tgz'
            Download ('https://registry.npmjs.org/' + $packages[$provider] + '/-/' + $packages[$provider].Split('/')[1] + '-' + $version + '.tgz') $package $expires
            Require (('sha512-' + [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($package)))) -ceq $integrity) 'PACKAGE_INTEGRITY_FAILED'
            $prefix=Join-Path $work 'prefix'; PrivateDirectory $prefix
            foreach ($name in @('user.npmrc','global.npmrc')) { [IO.File]::WriteAllText((Join-Path $work $name),'',$utf8) }
            $receipt.state='installing'; AtomicJson $receiptPath $receipt
            $timeout=[Math]::Min([long]900000, $expires-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Require ($timeout -gt 0) 'PLAN_EXPIRED'
            $npmArgs=@($runtime[1],'install','--global','--prefix',$prefix,'--registry','https://registry.npmjs.org','--cache',(Join-Path $work 'cache'),'--userconfig',(Join-Path $work 'user.npmrc'),'--globalconfig',(Join-Path $work 'global.npmrc'),'--no-audit','--no-fund','--silent',$package)
            $npmResult=[AgentCliProcess]::Run($runtime[0],$npmArgs,$work,(EnvironmentFor (Join-Path $work 'home') $nodeDirectory),[int]$timeout,65536)
            Require ($npmResult[0] -eq 0) 'NPM_FAILED'
            $binary=PackageExecutable $prefix $provider
            Require ((VersionOf $binary $provider) -ceq $version) 'INSTALLED_VERSION_MISMATCH'
            AtomicJson (Join-Path $prefix '.installed.json') @{provider=$provider;version=$version;integrity=$integrity;executableSha256=(FileHash $binary)}
            Require ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $expires) 'PLAN_EXPIRED'
            Require ((Inspect $root $provider).installationRevision -ceq $expected) 'STALE_INSTALLATION'
            $target='versions/' + $version + '-' + (HashBytes ($utf8.GetBytes($integrity))).Substring(0,16)
            $final=Join-Path $root $target; Require (-not (Test-Path -LiteralPath $final)) 'VERSION_ALREADY_STAGED'
            [IO.Directory]::Move($prefix,$final)
            AtomicJson (Join-Path $root 'current.json') @{active=$target}; $switched=$true
            $keepVersions=@($target.Substring(9)); if ($before.managed) { $keepVersions += $prior.Substring(9) }
            $failures=Cleanup $root $work $keepVersions
            if ($failures -gt 0) { $receipt['cleanupFailures']=$failures }
            $receipt.state='completed'; AtomicJson $receiptPath $receipt
            return $receipt
        } catch {
            $receipt.state='failed'; $receipt['error']='INSTALL_FAILED'
            if ($switched) {
                try {
                    Require ((ReadJson (Join-Path $root 'current.json')).active -ceq $target) 'RECOVERY_REQUIRED'
                    if ($before.managed) { AtomicJson (Join-Path $root 'current.json') @{active=$prior} }
                    else { Remove-Item -LiteralPath (Join-Path $root 'current.json') -Force }
                } catch { throw 'RECOVERY_REQUIRED' }
            }
            try { AtomicJson $receiptPath $receipt } catch { throw 'RESULT_UNKNOWN' }
            throw 'INSTALL_FAILED'
        }
    } finally { $lock.Dispose() }
}
function Main {
    Require ($CliArguments.Count -eq 7) 'INVALID_ARGUMENTS'
    $action,$provider,$version,$integrity,$expected,$expires,$operation=$CliArguments
    Require ($packages.ContainsKey($provider)) 'UNSUPPORTED_PROVIDER'
    Require ($homeDirectory -and [IO.Path]::IsPathRooted($homeDirectory)) 'UNSAFE_HOME'
    $root=Join-Path $homeDirectory ('.ssh-approval-cli\' + $provider)
    switch -CaseSensitive ($action) {
        'inspect' { Require (-not ($version + $integrity + $expected + $expires + $operation)) 'INVALID_ARGUMENTS'; return Inspect $root $provider }
        'status' { Require (-not ($version + $integrity + $expected + $expires)) 'INVALID_ARGUMENTS'; return Status $root $provider $operation }
        'login-status' {
            Require (-not ($version + $integrity + $expected + $expires + $operation)) 'INVALID_ARGUMENTS'
            try {
                $state=Inspect $root $provider
                if (-not $state.installed) { return @{provider=$provider;state='not_installed'} }
                $binary=if ($state.managed) { PackageExecutable (Join-Path $root $state.active) $provider } else { $state.active.Replace('/','\') }
                $cwd=Join-Path ([IO.Path]::GetTempPath()) ('ssh-cli-auth-' + [Guid]::NewGuid().ToString('N')); PrivateDirectory $cwd
                try { $result=RunCli $binary $(if ($provider -eq 'codex') { @('login','status') } else { @('auth','status') }) $cwd $true } finally { Remove-Item -LiteralPath $cwd -Recurse -Force }
                if ($provider -eq 'codex') {
                    if ($result[0] -eq 0) { return @{provider=$provider;state='signed_in'} }
                    if ($result[0] -eq 1 -and ($result[1]+$result[2]).Trim() -ceq 'Not logged in') { return @{provider=$provider;state='signed_out'} }
                } elseif (-not $result[2]) {
                    $auth=$result[1] | ConvertFrom-Json
                    if ($auth.loggedIn -is [bool]) {
                        if ($result[0] -eq 0 -and $auth.loggedIn) { return @{provider=$provider;state='signed_in'} }
                        if ($result[0] -eq 1 -and -not $auth.loggedIn) { return @{provider=$provider;state='signed_out'} }
                    }
                }
                return @{provider=$provider;state='unavailable';reason='unexpected_response'}
            } catch {
                $reason='check_failed'; $message=$_.Exception.ToString()
                if ($message -match 'UNSAFE_') { $reason='unsafe_path' } elseif ($message -match 'PROCESS_TIMEOUT') { $reason='timeout' } elseif ($message -match 'OUTPUT_LIMIT') { $reason='output_limit' }
                return @{provider=$provider;state='unavailable';reason=$reason}
            }
        }
        { $_ -cin @('install','update') } { Require ($expires -cmatch '^[0-9]{1,16}$') 'INVALID_PLAN'; return Install $root $action $provider $version $integrity $expected ([long]$expires) $operation }
        default { throw 'INVALID_ARGUMENTS' }
    }
}
try { [Console]::Out.WriteLine((Json (Main))) } catch { [Console]::Out.WriteLine('{"state":"refused","error":"UNAVAILABLE"}'); exit 1 }
