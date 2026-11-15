using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Miru.Core;

internal static class BoundedFileReader
{
    internal const int MaxBytes = 2 * 1024 * 1024;

    internal static byte[] Read(string path, string root)
    {
        using var handle = OpenRegularFile(path);
        var actual = GetOpenedPath(handle);
        if (!LocalPaths.IsInside(root, actual))
            throw new ViewerException("The opened file is outside the current top. Refresh the folder.");
        LocalPaths.RequireExisting(path);
        using var stream = new FileStream(handle, FileAccess.Read);
        if (!stream.CanSeek || stream.Length > MaxBytes)
            throw new ViewerException("Only ordinary files of at most 2 MiB can be displayed.");
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var count = stream.Read(buffer, 0, Math.Min(buffer.Length, MaxBytes + 1 - (int)output.Length));
            if (count == 0) break;
            output.Write(buffer, 0, count);
            if (output.Length > MaxBytes) throw new ViewerException("The file grew beyond the 2 MiB display limit.");
        }
        return output.ToArray();
    }

    private static SafeFileHandle OpenRegularFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            var handle = WindowsPathIdentity.OpenReadOnly(path);
            if (GetFileType(handle) == 1 && (File.GetAttributes(handle) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0)
                return handle;
            handle.Dispose();
            throw new ViewerException("Only ordinary disk files can be displayed.");
        }
        if (OperatingSystem.IsLinux())
        {
            // Linux is the Core test/WSL CLI host, not a native GUI target. Opening with
            // NONBLOCK prevents a FIFO from hanging before we can inspect its file type.
            var fd = Open(path, 0x80000 | 0x20000 | 0x800); // CLOEXEC | NOFOLLOW | NONBLOCK, RDONLY=0
            if (fd < 0) throw new IOException("The file could not be opened.", new Win32Exception(Marshal.GetLastPInvokeError()));
            var handle = new SafeFileHandle((IntPtr)fd, ownsHandle: true);
            if (Statx(fd, "", 0x1000, 1, out var status) == 0 && (status.Mode & 0xf000) == 0x8000)
                return handle;
            handle.Dispose();
            throw new ViewerException("Only ordinary files can be displayed.");
        }
        throw new PlatformNotSupportedException("The native MVP targets Windows; this file reader is not verified on this platform.");
    }

    private static string GetOpenedPath(SafeFileHandle handle)
    {
        if (OperatingSystem.IsLinux())
            return new FileInfo($"/proc/self/fd/{handle.DangerousGetHandle()}").LinkTarget
                ?? throw new ViewerException("The opened file path could not be verified.");
        return WindowsPathIdentity.FromHandle(handle);
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct StatxBuffer { [FieldOffset(28)] public ushort Mode; }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open(string path, int flags);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int fd, string path, int flags, uint mask, out StatxBuffer buffer);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);
}
