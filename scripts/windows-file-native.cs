using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace SshApproval {
    public sealed class FileFailure : Exception {
        public string Code { get; private set; }
        public string NativeStep { get; private set; }
        public int NativeError { get; private set; }
        public FileFailure(string code) : base(code) { Code = code; }
        public FileFailure(string code, string step, int error) : this(code) { NativeStep = step; NativeError = error; }
    }

    // All pathname components stay open without write/delete sharing until completion.
    // Opens fail immediately on conflicts: there is no lock wait or lock-order cycle.
    public static class WindowsFiles {
        const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
        const uint OpenReparse = 0x00200000, Backup = 0x02000000;
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
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor);
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateDirectory(string path, ref SecurityAttributes security);

        static void Fail(string code) { throw new FileFailure(code); }
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
        public static void CreatePrivateDirectory(string path, string sddl) {
            path = CheckedPath(path);
            using (DirectoryChain parent = new DirectoryChain(Path.GetDirectoryName(path), "PARENT_NOT_FOUND")) {
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
            public SafeFileHandle Last { get { return handles[handles.Count - 1]; } }
            public DirectoryChain(string path, string missing) {
                try {
                    string current = path.Substring(0, 3);
                    handles.Add(Open(current, 0x20080, 1, 3, true, missing));
                    foreach (string component in path.Substring(3).Split('\\')) {
                        current += (current.EndsWith("\\") ? "" : "\\") + component;
                        handles.Add(Open(current, 0x20080, 1, 3, true, missing));
                    }
                } catch { Dispose(); throw; }
            }
            public void Dispose() { for (int n = handles.Count - 1; n >= 0; n--) handles[n].Dispose(); }
        }
        static byte[] Security(SafeFileHandle handle) {
            uint size;
            GetKernelObjectSecurity(handle, 4, null, 0, out size);
            if (size == 0 || size > 65536) Fail("PERMISSION_DENIED");
            byte[] descriptor = new byte[size];
            if (!GetKernelObjectSecurity(handle, 4, descriptor, size, out size)) NativeFailure("OPERATION_FAILED", "read_security");
            return descriptor;
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
        public static Dictionary<string, object> Execute(string action, string id, string path, string hash, long size, long maximum, bool overwrite, string root, string stage, string account) {
            root = CheckedPath(root); stage = CheckedPath(stage);
            if (root.Equals(stage, StringComparison.OrdinalIgnoreCase) || Within(root, stage) || Within(stage, root)) Fail("STAGING_UNAVAILABLE");
            using (DirectoryChain stages = new DirectoryChain(stage, "STAGING_UNAVAILABLE"))
            using (DirectoryChain roots = new DirectoryChain(root, "PARENT_NOT_FOUND")) {
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
                            using (SafeFileHandle destination = Open(temporary, Read | Write | Delete | 0x40000, 1, 1, false, "PARENT_NOT_FOUND")) {
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
                                            if (!SetKernelObjectSecurity(destination, 4, Security(previous))) NativeFailure("OPERATION_FAILED", "write_security");
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
