using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace InstanceFinder;

internal sealed partial class GameProcess : IDisposable
{
    private const uint PROCESS_VM_READ           = 0x0010;
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;

    private static readonly byte?[] ContentReplyManagerSignature = ParseSignature
    (
        "48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? 45 33 C0 48 8D 57 ?? 41 8B CE E8 ?? ?? ?? ?? 48 8D 8F"
    );

    private static readonly byte?[] ZoneServerIDOffsetSignature = ParseSignature
    (
        "0F 11 83 ?? ?? ?? ?? 0F 10 4F ?? 0F 11 8B ?? ?? ?? ?? 0F 10 47 ?? 0F 11 83 ?? ?? ?? ?? 0F 10 4F ?? 0F 11 8B ?? ?? ?? ?? 0F 10 47 ?? 0F 11 83 ?? ?? ?? ?? 0F 10 4F ?? 0F 11 8B ?? ?? ?? ?? 0F 10 47 ?? 0F 11 83 ?? ?? ?? ?? 0F 10 4F"
    );

    private readonly Process           process;
    private readonly SafeProcessHandle handle;
    private readonly nint              zoneServerPacketAddress;

    public GameProcess(Process process)
    {
        this.process = process;
        handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, process.Id);

        if (handle.IsInvalid)
        {
            handle.Dispose();
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        }

        try
        {
            var imageBaseAddress = process.MainModule?.BaseAddress ?? throw new InvalidDataException();
            var (textAddress, text) = ReadTextSection(imageBaseAddress);
            var managerMatch = FindSignature(text, ContentReplyManagerSignature);
            var offsetMatch  = FindSignature(text, ZoneServerIDOffsetSignature);

            if (managerMatch < 0 || offsetMatch < 0) throw new KeyNotFoundException();

            var managerDisplacement = BinaryPrimitives.ReadInt32LittleEndian(text.AsSpan(managerMatch + 3, 4));
            var managerAddress      = textAddress + managerMatch + 7 + managerDisplacement;
            var zoneServerIDOffset  = BinaryPrimitives.ReadInt32LittleEndian(text.AsSpan(offsetMatch + 3, 4));

            zoneServerPacketAddress = managerAddress + zoneServerIDOffset;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public bool HasExited
    {
        get
        {
            try
            {
                return process.HasExited;
            }
            catch (InvalidOperationException)
            {
                return true;
            }
        }
    }

    public uint ReadZoneServerID()
    {
        var packet     = ReadBytes(zoneServerPacketAddress, 6);
        var serverID   = BinaryPrimitives.ReadUInt16LittleEndian(packet);
        var instanceID = BinaryPrimitives.ReadUInt16LittleEndian(packet.AsSpan(4));

        return ((uint)serverID << 16) | instanceID;
    }

    public void Dispose() => handle.Dispose();

    private (nint Address, byte[] Data) ReadTextSection(nint imageBaseAddress)
    {
        var dosHeader = ReadBytes(imageBaseAddress, 0x40);
        if (BinaryPrimitives.ReadUInt16LittleEndian(dosHeader) != 0x5A4D) throw new InvalidDataException();

        var peOffset = BinaryPrimitives.ReadInt32LittleEndian(dosHeader.AsSpan(0x3C));
        if (peOffset < 0x40) throw new InvalidDataException();

        var peHeader = ReadBytes(imageBaseAddress + peOffset, 24);
        if (BinaryPrimitives.ReadUInt32LittleEndian(peHeader) != 0x00004550) throw new InvalidDataException();

        var sectionCount      = BinaryPrimitives.ReadUInt16LittleEndian(peHeader.AsSpan(6));
        var optionalHeaderSize = BinaryPrimitives.ReadUInt16LittleEndian(peHeader.AsSpan(20));
        if (sectionCount is 0 or > 96) throw new InvalidDataException();

        var sectionTable = imageBaseAddress + peOffset + 24 + optionalHeaderSize;
        var sections     = ReadBytes(sectionTable, sectionCount * 40);

        for (var index = 0; index < sectionCount; index++)
        {
            var section = sections.AsSpan(index * 40, 40);
            var name    = Encoding.ASCII.GetString(section[..8]).TrimEnd('\0');
            if (name != ".text") continue;

            var virtualSize    = BinaryPrimitives.ReadUInt32LittleEndian(section[8..]);
            var virtualAddress = BinaryPrimitives.ReadUInt32LittleEndian(section[12..]);
            if (virtualSize is 0 or > int.MaxValue) throw new InvalidDataException();

            var address = imageBaseAddress + (nint)virtualAddress;
            return (address, ReadBytes(address, (int)virtualSize));
        }

        throw new InvalidDataException();
    }

    private byte[] ReadBytes(nint address, int length)
    {
        var data = GC.AllocateUninitializedArray<byte>(length);
        if (ReadProcessMemory(handle, address, data, (nuint)length, out var bytesRead) && bytesRead == (nuint)length)
            return data;

        throw new Win32Exception(Marshal.GetLastPInvokeError());
    }

    private static int FindSignature(ReadOnlySpan<byte> data, ReadOnlySpan<byte?> signature)
    {
        for (var offset = 0; offset <= data.Length - signature.Length; offset++)
        {
            var matches = true;

            for (var index = 0; index < signature.Length; index++)
            {
                if (signature[index] is not { } expected || data[offset + index] == expected) continue;

                matches = false;
                break;
            }

            if (matches) return offset;
        }

        return -1;
    }

    private static byte?[] ParseSignature(string signature) =>
        signature.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                 .Select(value => value == "??" ? null : (byte?)Convert.ToByte(value, 16))
                 .ToArray();

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial SafeProcessHandle OpenProcess
    (
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processID
    );

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ReadProcessMemory
    (
        SafeProcessHandle processHandle,
        nint               baseAddress,
        [Out] byte[]       buffer,
        nuint              size,
        out nuint          bytesRead
    );
}
