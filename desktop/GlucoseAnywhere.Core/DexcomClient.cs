using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GlucoWatch;

public enum DexcomRegion { US, OutsideUS, Japan }

public sealed record GlucoseReading(DateTimeOffset Time, int Mgdl, string Trend);

public sealed class DexcomException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    /// <summary>True when retrying with the same credentials is pointless (and could lock the account).</summary>
    public bool IsAuthError => Code.StartsWith("SSO_") || Code.StartsWith("Account") || Code == "InvalidPassword";
}

/// <summary>
/// Minimal client for the Dexcom Share web service (the backend used by the Dexcom Follow app).
/// </summary>
public sealed partial class DexcomClient : IDisposable
{
    const string AppId = "d89443d2-327c-4a6f-89e5-496bbb0317db";
    const string AppIdJapan = "d8665ade-9673-4e27-9ff6-92db4ce13d13";
    const string EmptyGuid = "00000000-0000-0000-0000-000000000000";

    static readonly string[] TrendNames =
        ["None", "DoubleUp", "SingleUp", "FortyFiveUp", "Flat", "FortyFiveDown", "SingleDown", "DoubleDown", "NotComputable", "RateOutOfRange"];

    readonly HttpClient http;
    readonly string username;
    readonly string password;
    readonly string appId;
    string? accountId;
    string? sessionId;

    public DexcomClient(string username, string password, DexcomRegion region)
    {
        this.username = username.Trim();
        this.password = password;
        appId = region == DexcomRegion.Japan ? AppIdJapan : AppId;

        var baseUrl = region switch
        {
            DexcomRegion.OutsideUS => "https://shareous1.dexcom.com/ShareWebServices/Services/",
            DexcomRegion.Japan => "https://share.dexcom.jp/ShareWebServices/Services/",
            _ => "https://share2.dexcom.com/ShareWebServices/Services/",
        };
        http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        http.DefaultRequestHeaders.UserAgent.ParseAdd("GlucoseAnywhere/1.0");
    }

    public async Task<IReadOnlyList<GlucoseReading>> GetReadingsAsync(int minutes, int maxCount, CancellationToken ct)
    {
        sessionId ??= await LoginAsync(ct);
        try
        {
            return await ReadAsync(minutes, maxCount, ct);
        }
        catch (DexcomException ex) when (ex.Code is "SessionIdNotFound" or "SessionNotValid")
        {
            sessionId = await LoginAsync(ct);
            return await ReadAsync(minutes, maxCount, ct);
        }
    }

    async Task<string> LoginAsync(CancellationToken ct)
    {
        if (accountId is null)
        {
            var id = Guid.TryParse(username, out _)
                ? username
                : await PostAsync<string>("General/AuthenticatePublisherAccount",
                    new { accountName = username, password, applicationId = appId }, ct);
            if (string.IsNullOrEmpty(id) || id == EmptyGuid)
                throw new DexcomException("AccountNotFound", "Dexcom account not found.");
            accountId = id;
        }

        var sid = await PostAsync<string>("General/LoginPublisherAccountById",
            new { accountId, password, applicationId = appId }, ct);
        if (string.IsNullOrEmpty(sid) || sid == EmptyGuid)
            throw new DexcomException("InvalidPassword", "Dexcom rejected the password.");
        return sid;
    }

    async Task<IReadOnlyList<GlucoseReading>> ReadAsync(int minutes, int maxCount, CancellationToken ct)
    {
        var rows = await PostAsync<List<ShareReading>>(
            $"Publisher/ReadPublisherLatestGlucoseValues?sessionId={sessionId}&minutes={minutes}&maxCount={maxCount}",
            new { }, ct) ?? [];

        var result = new List<GlucoseReading>(rows.Count);
        foreach (var row in rows)
        {
            var match = DateRegex().Match(row.WT ?? row.ST ?? "");
            if (!match.Success) continue;
            var time = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(match.Groups[1].Value)).ToLocalTime();
            result.Add(new GlucoseReading(time, row.Value, ParseTrend(row.Trend)));
        }
        result.Sort((a, b) => a.Time.CompareTo(b.Time));
        return result;
    }

    static string ParseTrend(JsonElement trend) => trend.ValueKind switch
    {
        JsonValueKind.String => trend.GetString() ?? "None",
        JsonValueKind.Number when trend.TryGetInt32(out var i) && i >= 0 && i < TrendNames.Length => TrendNames[i],
        _ => "None",
    };

    async Task<T?> PostAsync<T>(string path, object body, CancellationToken ct)
    {
        using var resp = await http.PostAsJsonAsync(path, body, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            ShareError? err = null;
            try { err = JsonSerializer.Deserialize<ShareError>(text); } catch (JsonException) { }
            throw new DexcomException(err?.Code ?? $"HTTP{(int)resp.StatusCode}",
                err?.Message ?? $"Dexcom returned HTTP {(int)resp.StatusCode}.");
        }
        return JsonSerializer.Deserialize<T>(text);
    }

    public void Dispose() => http.Dispose();

    // "Date(1691455258000-0400)" -> 1691455258000
    [GeneratedRegex(@"Date\((\d+)")]
    private static partial Regex DateRegex();

    sealed class ShareReading
    {
        public string? WT { get; set; }
        public string? ST { get; set; }
        public int Value { get; set; }
        public JsonElement Trend { get; set; }
    }

    sealed class ShareError
    {
        public string? Code { get; set; }
        public string? Message { get; set; }
    }
}
