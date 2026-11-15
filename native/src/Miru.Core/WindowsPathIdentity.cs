using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Miru.Core;

internal static class WindowsPathIdentity
{
    internal static string Canonicalize(string path)
    {
        // Attribute-only access, OPEN_EXISTING, including directories. No file creation/write.
        using var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) throw new ViewerException("The Windows path could not be verified.");
        if ((File.GetAttributes(handle) & FileAttributes.ReparsePoint) != 0)
            throw new ViewerException("Links and junctions are not opened by this native MVP.");
        return FromHandle(handle);
    }

    internal static SafeFileHandle OpenReadOnly(string path)
    {
        // GENERIC_READ, OPEN_EXISTING, OPEN_REPARSE_POINT: never follow the final link.
        var handle = CreateFile(path, 0x80000000, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        throw new ViewerException("The Windows file could not be opened for reading.");
    }

    internal static string FromHandle(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
            throw new ViewerException("The opened Windows file path could not be verified.");
        var value = buffer.ToString();
        if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) value = "\\\\" + value[8..];
        else if (value.StartsWith("\\\\?\\", StringComparison.Ordinal)) value = value[4..];
        return Path.TrimEndingDirectorySeparator(LocalPaths.ValidateWindowsPath(value));
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
}
