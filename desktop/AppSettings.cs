using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GlucoWatch;

public sealed class AppSettings
{
    static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "GlucoseAnywhere", "settings.json");

    static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public string Username { get; set; } = "";
    /// <summary>Password encrypted with Windows DPAPI for the current user.</summary>
    public string? ProtectedPassword { get; set; }
    public DexcomRegion Region { get; set; } = DexcomRegion.US;
    public bool UseMmol { get; set; }
    public int LowMgdl { get; set; } = 70;
    public int HighMgdl { get; set; } = 180;
    public int ChartHours { get; set; } = 3;
    public bool Topmost { get; set; }
    public bool BigMode { get; set; }
    public double? Left { get; set; }
    public double? Top { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }

    [JsonIgnore]
    public bool HasCredentials => !string.IsNullOrWhiteSpace(Username) && !string.IsNullOrEmpty(ProtectedPassword);

    [JsonIgnore]
    public string Password
    {
        get
        {
            if (string.IsNullOrEmpty(ProtectedPassword)) return "";
            try
            {
                var bytes = ProtectedData.Unprotect(Convert.FromBase64String(ProtectedPassword), null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(bytes);
            }
            catch (Exception ex) when (ex is CryptographicException or FormatException)
            {
                return "";
            }
        }
        set => ProtectedPassword = Convert.ToBase64String(
            ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    }

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), JsonOptions) ?? new();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { }
        return new();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, JsonOptions));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}
