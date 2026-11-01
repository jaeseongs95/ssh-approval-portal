using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace SshApproval {
    public sealed class FileFailure : Exception {
        public string Code { get; private set; }
        public string NativeStep { get; private set; }
        public int NativeError { get; private set; }
        public int SecurityControlBefore { get; private set; }
        public int SecurityControlAfter { get; private set; }
        public FileFailure(string code) : base(code) { Code = code; SecurityControlBefore = -1; SecurityControlAfter = -1; }
        public FileFailure(string code, string step, int error, int controlBefore = -1, int controlAfter = -1) : this(code) {
            NativeStep = step; NativeError = error; SecurityControlBefore = controlBefore; SecurityControlAfter = controlAfter;
        }
    }

    // All pathname components stay open without write/delete sharing until completion.
    // Opens fail immediately on conflicts: there is no lock wait or lock-order cycle.
    public static class WindowsFiles {
        const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
        const uint OpenReparse = 0x00200000, Backup = 0x02000000;
        const string TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
        [StructLayout(LayoutKind.Sequential)]
        struct Info {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
            public long Size { get { return ((long)SizeHigh << 32) | SizeLow; } }
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint GetFileType(SafeFileHandle handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, IntPtr volumeName, uint volumeSize, IntPtr serial, IntPtr componentLength, IntPtr flags, StringBuilder fileSystem, uint fileSystemSize);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr value, uint length);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor, uint length, out uint needed);
        [DllImport("advapi32.dll")]
        static extern uint SetSecurityInfo(SafeFileHandle handle, uint objectType, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetSecurityDescriptorOwner(IntPtr descriptor, out IntPtr owner, out bool defaulted);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFileTime(SafeFileHandle handle, ref System.Runtime.InteropServices.ComTypes.FILETIME created,
            ref System.Runtime.InteropServices.ComTypes.FILETIME accessed, ref System.Runtime.InteropServices.ComTypes.FILETIME written);
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateDirectory(string path, ref SecurityAttributes security);

        static void Fail(string code) { throw new FileFailure(code); }
        public static void RequireAdministrator() {
            // IsInRole checks the effective token, including disabled/deny-only UAC groups.
            // Never acquire another token or enable a privilege on the caller's behalf.
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
                if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) Fail("PERMISSION_DENIED");
            }
        }
        static void NativeFailure(string missing, string step = "native") {
            int error = Marshal.GetLastWin32Error();
            string code = error == 2 || error == 3 ? missing : error == 5 || error == 32 || error == 33 ? "PERMISSION_DENIED" :
                error == 80 || error == 183 ? "DESTINATION_EXISTS" : error == 1920 || error == 4390 ? "UNSAFE_PATH" : "OPERATION_FAILED";
            throw new FileFailure(code, step, error);
        }
        public static string CheckedPath(string value) {
            if (value == null || value.Length < 4 || value.Length > 4096 || !Regex.IsMatch(value, @"\A[A-Za-z]:[/\\]")) Fail("UNSAFE_PATH");
            value = value.Replace('/', '\\');
            foreach (char c in value) if (c < 32 || (c >= 127 && c < 160) || c == '\u202e' || c == '\u202d' || c == '\u200b' || c == '\ufeff') Fail("UNSAFE_PATH");
            string[] parts = value.Substring(3).Split('\\');
            foreach (string part in parts) {
                if (part.Length == 0 || part.Length > 255 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOfAny(new char[] { ':', '*', '?', '"', '<', '>', '|' }) >= 0 ||
                    Regex.IsMatch(part, @"\A(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|\z)", RegexOptions.IgnoreCase)) Fail("UNSAFE_PATH");
            }
            return Char.ToUpperInvariant(value[0]) + value.Substring(1);
        }
        static bool Within(string path, string root) { return path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
        public static void CreatePrivateDirectory(string path, string sddl, string account, string installer, bool trustAccount) {
            path = CheckedPath(path);
            using (DirectoryChain parent = new DirectoryChain(Path.GetDirectoryName(path), "PARENT_NOT_FOUND")) {
                parent.CheckTrust(account, installer, trustAccount);
                RawSecurityDescriptor descriptor = new RawSecurityDescriptor(sddl);
                byte[] bytes = new byte[descriptor.BinaryLength];
                descriptor.GetBinaryForm(bytes, 0);
                GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try {
                    SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pin.AddrOfPinnedObject(), Inherit = 0 };
                    if (!CreateDirectory("\\\\?\\" + path, ref security)) NativeFailure("PARENT_NOT_FOUND", "create_directory");
                } finally { pin.Free(); }
            }
        }
        static Info Inspect(SafeFileHandle handle, bool directory) {
            Info info;
            if (!GetFileInformationByHandle(handle, out info)) NativeFailure("OPERATION_FAILED", "inspect");
            if (GetFileType(handle) != 1 || (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1)) Fail("UNSAFE_PATH");
            return info;
        }
        static SafeFileHandle Open(string path, uint access, uint share, uint disposition, bool directory, string missing) {
            SafeFileHandle handle = CreateFile("\\\\?\\" + path, access, share, IntPtr.Zero, disposition, OpenReparse | (directory ? Backup : 0), IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); NativeFailure(missing, "open"); }
            try {
                Inspect(handle, directory);
                StringBuilder fileSystem = new StringBuilder(32);
                if (!GetVolumeInformationByHandleW(handle, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, fileSystem, (uint)fileSystem.Capacity)) NativeFailure("OPERATION_FAILED", "filesystem");
                if (!fileSystem.ToString().Equals("NTFS", StringComparison.OrdinalIgnoreCase)) throw new FileFailure("OPERATION_FAILED", "filesystem", 50);
                StringBuilder actual = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(handle, actual, (uint)actual.Capacity, 0);
                if (length == 0) NativeFailure(missing, "final_path");
                if (length >= actual.Capacity || !actual.ToString().TrimEnd('\\').Equals(("\\\\?\\" + path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) Fail("UNSAFE_PATH");
                return handle;
            } catch { handle.Dispose(); throw; }
        }
        sealed class DirectoryChain : IDisposable {
            readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
            readonly List<SafeFileHandle> guards = new List<SafeFileHandle>();
            readonly string path;
            public SafeFileHandle Last { get { return handles[handles.Count - 1]; } }
            public DirectoryChain(string path, string missing) {
                this.path = path;
                try {
                    string current = path.Substring(0, 3);
                    handles.Add(Open(current, 0x20080, 1, 3, true, missing));
                    if (path.Length > 3) foreach (string component in path.Substring(3).Split('\\')) {
                        current += (current.EndsWith("\\") ? "" : "\\") + component;
                        handles.Add(Open(current, 0x20080, 1, 3, true, missing));
                    }
                } catch { Dispose(); throw; }
            }
            public void CheckTrust(string account, string installer, bool trustAccount) {
                for (int n = 0; n < handles.Count; n++) {
                    bool last = n == handles.Count - 1;
                    bool guarded = last && path.Equals(@"C:\ProgramData", StringComparison.OrdinalIgnoreCase) && PinExistingChild();
                    CheckAncestor(handles[n], account, installer, trustAccount, last && !guarded, n == 0);
                }
            }
            bool PinExistingChild() {
                // Only the Windows default ProgramData parent receives this exception.
                // An existing child held without delete sharing keeps it nonempty, so
                // attribute-only access cannot turn that parent into a reparse point.
                int examined = 0;
                foreach (string candidate in Directory.EnumerateFileSystemEntries(path)) {
                    if (++examined > 64) break;
                    try {
                        CheckedPath(candidate);
                        bool directory = (File.GetAttributes(candidate) & FileAttributes.Directory) != 0;
                        SafeFileHandle child = Open(candidate, 0x80, 1, 3, directory, "FILE_NOT_FOUND");
                        guards.Add(child);
                        return true;
                    } catch (FileFailure) { }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
                return false;
            }
            public void Dispose() {
                for (int n = guards.Count - 1; n >= 0; n--) guards[n].Dispose();
                for (int n = handles.Count - 1; n >= 0; n--) handles[n].Dispose();
            }
        }
        public static IDisposable PinTrustedDirectory(string path, string account, string installer, bool trustAccount) {
            DirectoryChain chain = new DirectoryChain(path, "PARENT_NOT_FOUND");
            try { chain.CheckTrust(account, installer, trustAccount); return chain; }
            catch { chain.Dispose(); throw; }
        }
        static byte[] Security(SafeFileHandle handle, uint information = 5, string step = "read_security") {
            uint size;
            GetKernelObjectSecurity(handle, information, null, 0, out size);
            if (size == 0) NativeFailure("OPERATION_FAILED", step);
            if (size > 65536) Fail("PERMISSION_DENIED");
            byte[] descriptor = new byte[size];
            if (!GetKernelObjectSecurity(handle, information, descriptor, size, out size)) NativeFailure("OPERATION_FAILED", step);
            return descriptor;
        }
        static bool Trusted(string sid, string account, string installer, bool trustAccount) {
            return sid == "S-1-5-18" || sid == "S-1-5-32-544" || sid == installer || (trustAccount && sid == account);
        }
        static void CheckAncestor(SafeFileHandle handle, string account, string installer, bool trustAccount, bool last, bool volumeRoot) {
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(Security(handle), 0);
            // Ownership normally grants WRITE_DAC even without an explicit allow ACE.
            if (descriptor.Owner == null || (!Trusted(descriptor.Owner.Value, account, installer, trustAccount) &&
                !(volumeRoot && descriptor.Owner.Value == TrustedInstaller)) || descriptor.DiscretionaryAcl == null) Fail("PERMISSION_DENIED");
            foreach (GenericAce ace in descriptor.DiscretionaryAcl) {
                if ((ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
                QualifiedAce allowed = ace as QualifiedAce;
                if (allowed == null) Fail("PERMISSION_DENIED");
                if (allowed.AceQualifier != AceQualifier.AccessAllowed) continue;
                // Creation alone cannot replace an existing protected child. Deletion or
                // security-control rights can; the volume root's ordinary create grants stay valid.
                // Intermediate directories cannot become empty while the next component
                // is pinned without delete sharing. The final parent has no such child:
                // attribute-only opens bypass share checks and could set a reparse point.
                int unsafeRights = unchecked((int)0x100D0040) | (last ? unchecked((int)0x40000100) : 0);
                if ((allowed.AccessMask & unsafeRights) != 0 &&
                    !Trusted(allowed.SecurityIdentifier.Value, account, installer, trustAccount)) Fail("PERMISSION_DENIED");
            }
        }
        static void CheckWriters(SafeFileHandle handle, string account, string failure) {
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(Security(handle), 0);
            if (descriptor.DiscretionaryAcl == null) Fail(failure);
            foreach (GenericAce ace in descriptor.DiscretionaryAcl) {
                QualifiedAce allowed = ace as QualifiedAce;
                if (allowed == null) Fail(failure);
                if (allowed.AceQualifier != AceQualifier.AccessAllowed) continue;
                string sid = allowed.SecurityIdentifier.Value;
                if ((allowed.AccessMask & unchecked((int)0x500D0156)) != 0 && sid != account && sid != "S-1-5-18" && sid != "S-1-5-32-544") Fail(failure);
            }
        }
        static bool Same(Info a, Info b) {
            return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow && a.Size == b.Size &&
                a.Written.dwHighDateTime == b.Written.dwHighDateTime && a.Written.dwLowDateTime == b.Written.dwLowDateTime && a.Links == b.Links;
        }
        static bool SameTime(System.Runtime.InteropServices.ComTypes.FILETIME a, System.Runtime.InteropServices.ComTypes.FILETIME b) {
            return a.dwHighDateTime == b.dwHighDateTime && a.dwLowDateTime == b.dwLowDateTime;
        }
        static byte[] LabelAcl(byte[] descriptor) {
            GCHandle pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            try {
                IntPtr acl;
                bool present, defaulted;
                if (!GetSecurityDescriptorSacl(pin.AddrOfPinnedObject(), out present, out acl, out defaulted)) NativeFailure("OPERATION_FAILED", "read_label");
                if (!present || acl == IntPtr.Zero || Marshal.ReadInt16(acl, 4) == 0) return new byte[0];
                int length = (ushort)Marshal.ReadInt16(acl, 2);
                if (length < 8 || length > descriptor.Length) Fail("PERMISSION_DENIED");
                byte[] bytes = new byte[length];
                Marshal.Copy(acl, bytes, 0, length);
                return bytes;
            } finally { pin.Free(); }
        }
        static bool SameBytes(byte[] a, byte[] b) {
            if (a.Length != b.Length) return false;
            for (int n = 0; n < a.Length; n++) if (a[n] != b[n]) return false;
            return true;
        }
        static void PreserveLabel(SafeFileHandle previous, SafeFileHandle destination) {
            // LABEL_SECURITY_INFORMATION reads only mandatory labels with READ_CONTROL;
            // WRITE_OWNER sets them. Never request or enable SeSecurity/SeRelabel privileges.
            byte[] label = Security(previous, 0x10, "read_label");
            byte[] expected = LabelAcl(label);
            if (!SameBytes(expected, LabelAcl(Security(destination, 0x10, "read_label")))) {
                GCHandle pin = GCHandle.Alloc(label, GCHandleType.Pinned);
                try {
                    IntPtr acl;
                    bool present, defaulted;
                    if (!GetSecurityDescriptorSacl(pin.AddrOfPinnedObject(), out present, out acl, out defaulted)) NativeFailure("OPERATION_FAILED", "read_label");
                    uint error = SetSecurityInfo(destination, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, present ? acl : IntPtr.Zero);
                    if (error != 0) throw new FileFailure(error == 5 || error == 1314 ? "PERMISSION_DENIED" : "OPERATION_FAILED", "write_label", (int)error);
                } finally { pin.Free(); }
            }
            if (!SameBytes(expected, LabelAcl(Security(previous, 0x10, "read_label"))) ||
                !SameBytes(expected, LabelAcl(Security(destination, 0x10, "read_label")))) throw new FileFailure("FILE_CHANGED", "verify_label", 0);
        }
        static void PreserveMetadata(SafeFileHandle previous, SafeFileHandle destination, Info old) {
            // This contract covers owner, DACL, mandatory label and three basic times.
            // Other SACL entries and ADS are not copied.
            byte[] security = Security(previous);
            RawSecurityDescriptor before = new RawSecurityDescriptor(security, 0);
            if (before.Owner == null || before.DiscretionaryAcl == null) Fail("PERMISSION_DENIED");
            string expectedSecurity = before.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
            bool protectedAcl = (before.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0;
            // A new file in the same parent can already have exactly the required
            // owner/DACL/control flags. Avoid reapplying inheritance in that case.
            if (expectedSecurity != new RawSecurityDescriptor(Security(destination), 0).GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access)) {
                GCHandle pin = GCHandle.Alloc(security, GCHandleType.Pinned);
                try {
                    IntPtr owner, dacl;
                    bool defaulted, present;
                    if (!GetSecurityDescriptorOwner(pin.AddrOfPinnedObject(), out owner, out defaulted)) NativeFailure("OPERATION_FAILED", "read_security");
                    if (!GetSecurityDescriptorDacl(pin.AddrOfPinnedObject(), out present, out dacl, out defaulted)) NativeFailure("OPERATION_FAILED", "read_security");
                    if (owner == IntPtr.Zero || !present || dacl == IntPtr.Zero) Fail("PERMISSION_DENIED");
                    uint error = SetSecurityInfo(destination, 1, 5u | (protectedAcl ? 0x80000000u : 0x20000000u), owner, IntPtr.Zero, dacl, IntPtr.Zero);
                    if (error != 0) throw new FileFailure(error == 5 || error == 1307 || error == 1314 ? "PERMISSION_DENIED" : "OPERATION_FAILED", "write_security", (int)error);
                } finally { pin.Free(); }
            }
            RawSecurityDescriptor after = new RawSecurityDescriptor(Security(destination), 0);
            if (expectedSecurity != after.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access)) {
                string step = "verify_control";
                if (after.Owner == null || !before.Owner.Equals(after.Owner)) step = "verify_owner";
                else if (after.DiscretionaryAcl == null) step = "verify_dacl";
                else {
                    byte[] expectedAcl = new byte[before.DiscretionaryAcl.BinaryLength];
                    byte[] actualAcl = new byte[after.DiscretionaryAcl.BinaryLength];
                    before.DiscretionaryAcl.GetBinaryForm(expectedAcl, 0);
                    after.DiscretionaryAcl.GetBinaryForm(actualAcl, 0);
                    if (!SameBytes(expectedAcl, actualAcl)) step = "verify_dacl";
                }
                // Only DACL control bits are diagnostic; never return owner SIDs or ACEs.
                throw new FileFailure("FILE_CHANGED", step, 0, (int)before.ControlFlags & 0x150C, (int)after.ControlFlags & 0x150C);
            }
            PreserveLabel(previous, destination);
            if (!SetFileTime(destination, ref old.Created, ref old.Accessed, ref old.Written)) NativeFailure("OPERATION_FAILED", "write_times");
            // Suppress deferred access/write updates when the copied-data handle closes.
            System.Runtime.InteropServices.ComTypes.FILETIME unchanged = new System.Runtime.InteropServices.ComTypes.FILETIME();
            System.Runtime.InteropServices.ComTypes.FILETIME frozen = new System.Runtime.InteropServices.ComTypes.FILETIME { dwHighDateTime = -1, dwLowDateTime = -1 };
            if (!SetFileTime(destination, ref unchanged, ref frozen, ref frozen)) NativeFailure("OPERATION_FAILED", "write_times");
            Info actual = Inspect(destination, false);
            if (!SameTime(old.Created, actual.Created) || !SameTime(old.Accessed, actual.Accessed) || !SameTime(old.Written, actual.Written)) throw new FileFailure("FILE_CHANGED", "verify_times", 0);
        }
        static FileStream Stream(SafeFileHandle handle, FileAccess access) {
            // FileStream owns only this non-owning wrapper; the operation retains the real handle.
            return new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), access, 256 * 1024, false);
        }
        static Dictionary<string, object> Copy(FileStream source, FileStream target, long maximum) {
            using (SHA256 sha = SHA256.Create()) {
                byte[] bytes = new byte[256 * 1024];
                long size = 0;
                int length;
                while ((length = source.Read(bytes, 0, bytes.Length)) > 0) {
                    size += length;
                    if (size > maximum) Fail("FILE_TOO_LARGE");
                    sha.TransformBlock(bytes, 0, length, null, 0);
                    target.Write(bytes, 0, length);
                }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                target.Flush(true);
                return new Dictionary<string, object> { { "size", size }, { "sha256", BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant() } };
            }
        }
        static void Remove(SafeFileHandle handle) {
            IntPtr data = Marshal.AllocHGlobal(4);
            try {
                Marshal.WriteInt32(data, 1);
                if (!SetFileInformationByHandle(handle, 4, data, 4)) NativeFailure("OPERATION_FAILED", "remove");
            } finally { Marshal.FreeHGlobal(data); }
        }
        static void Rename(SafeFileHandle handle, string path, bool overwrite) {
            // An absolute name avoids Win32's inconsistent RootDirectory handling.
            // Every ancestor remains pinned; the destination name is never followed.
            byte[] name = Encoding.Unicode.GetBytes("\\\\?\\" + path);
            int pointer = IntPtr.Size == 8 ? 8 : 4;
            int lengthOffset = pointer + IntPtr.Size;
            int nameOffset = lengthOffset + 4;
            IntPtr data = Marshal.AllocHGlobal(nameOffset + name.Length + 2);
            try {
                for (int n = 0; n < nameOffset + name.Length + 2; n++) Marshal.WriteByte(data, n, 0);
                // FileRenameInfoEx plus POSIX semantics replaces an open destination
                // while its read-only identity/security handle remains pinned.
                // Unsupported Windows/filesystem drivers fail closed; never drop that handle.
                Marshal.WriteInt32(data, overwrite ? 3 : 0);
                Marshal.WriteIntPtr(data, pointer, IntPtr.Zero);
                Marshal.WriteInt32(data, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(data, nameOffset), name.Length);
                if (!SetFileInformationByHandle(handle, overwrite ? 22 : 3, data, (uint)(nameOffset + name.Length + 2))) NativeFailure("OPERATION_FAILED", overwrite ? "rename_replace" : "rename_new");
            } finally { Marshal.FreeHGlobal(data); }
        }
        public static Dictionary<string, object> Execute(string action, string id, string path, string hash, long size, long maximum, bool overwrite, string root, string stage, string account, string installer) {
            root = CheckedPath(root); stage = CheckedPath(stage);
            if (root.Equals(stage, StringComparison.OrdinalIgnoreCase) || Within(root, stage) || Within(stage, root)) Fail("STAGING_UNAVAILABLE");
            using (DirectoryChain stages = new DirectoryChain(stage, "STAGING_UNAVAILABLE"))
            using (DirectoryChain roots = new DirectoryChain(root, "PARENT_NOT_FOUND")) {
                stages.CheckTrust(account, installer, true);
                roots.CheckTrust(account, installer, true);
                CheckWriters(stages.Last, account, "STAGING_UNAVAILABLE");
                CheckWriters(roots.Last, account, "PERMISSION_DENIED");
                string staged = stage + "\\" + id + ".part";
                if (action == "cleanup") {
                    try { using (SafeFileHandle file = Open(staged, Delete, 1, 3, false, "FILE_NOT_FOUND")) Remove(file); }
                    catch (FileFailure failure) { if (failure.Code != "FILE_NOT_FOUND") throw; }
                    return new Dictionary<string, object> { { "cleaned", true } };
                }
                path = CheckedPath(path);
                if (!Within(path, root)) Fail("UNSAFE_PATH");
                using (DirectoryChain parents = new DirectoryChain(Path.GetDirectoryName(path), "PARENT_NOT_FOUND")) {
                    parents.CheckTrust(account, installer, true);
                    CheckWriters(parents.Last, account, "PERMISSION_DENIED");
                    if (action == "snapshot") {
                        using (SafeFileHandle source = Open(path, Read, 1, 3, false, "FILE_NOT_FOUND")) {
                            Info before = Inspect(source, false);
                            if (before.Size > maximum) Fail("FILE_TOO_LARGE");
                            using (SafeFileHandle destination = Open(staged, Read | Write | Delete, 1, 1, false, "STAGING_UNAVAILABLE")) {
                                bool complete = false;
                                try {
                                    using (FileStream input = Stream(source, FileAccess.Read))
                                    using (FileStream output = Stream(destination, FileAccess.ReadWrite)) {
                                        Dictionary<string, object> result = Copy(input, output, maximum);
                                        if (!Same(before, Inspect(source, false))) Fail("FILE_CHANGED");
                                        complete = true;
                                        return result;
                                    }
                                } finally { if (!complete && !destination.IsClosed) Remove(destination); }
                            }
                        }
                    }
                    if (action != "publish") Fail("INVALID_REQUEST");
                    SafeFileHandle previous = null;
                    Info old = new Info();
                    try {
                        try { previous = Open(path, Read | 0x20000, 1 | 4, 3, false, "FILE_NOT_FOUND"); old = Inspect(previous, false); }
                        catch (FileFailure failure) { if (failure.Code != "FILE_NOT_FOUND") throw; }
                        if (previous != null && !overwrite) Fail("DESTINATION_EXISTS");
                        using (SafeFileHandle source = Open(staged, Read, 1, 3, false, "STAGING_UNAVAILABLE")) {
                            Info before = Inspect(source, false);
                            if (before.Size != size) Fail("FILE_CHANGED");
                            string temporary = Path.GetDirectoryName(path) + "\\.ssh-approval-" + Guid.NewGuid().ToString("N") + ".part";
                            using (SafeFileHandle destination = Open(temporary, Read | Write | Delete | 0xC0000, 1, 1, false, "PARENT_NOT_FOUND")) {
                                bool published = false;
                                try {
                                    using (FileStream input = Stream(source, FileAccess.Read))
                                    using (FileStream output = Stream(destination, FileAccess.ReadWrite)) {
                                        Dictionary<string, object> result = Copy(input, output, maximum);
                                        if ((long)result["size"] != size || (string)result["sha256"] != hash || !Same(before, Inspect(source, false))) Fail("FILE_CHANGED");
                                        if (previous != null) {
                                            using (SafeFileHandle current = Open(path, Read, 1 | 4, 3, false, "FILE_CHANGED")) {
                                                if (!Same(old, Inspect(current, false))) Fail("FILE_CHANGED");
                                            }
                                            PreserveMetadata(previous, destination, old);
                                        }
                                        // With no previous destination, never replace a file created concurrently.
                                        Rename(destination, path, previous != null && overwrite);
                                        published = true;
                                        result.Add("published", true);
                                        return result;
                                    }
                                } finally { if (!published && !destination.IsClosed) Remove(destination); }
                            }
                        }
                    } finally { if (previous != null) previous.Dispose(); }
                }
            }
        }
    }
}
