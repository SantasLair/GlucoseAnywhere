using System.Globalization;
using System.Windows.Media;

namespace GlucoWatch;

/// <summary>Formatting and colour helpers shared by the main window and the chart.</summary>
public static class Glucose
{
    public const double MmolFactor = 18.0182;

    public static readonly Brush InRange = Freeze(Color.FromRgb(0x4C, 0xC3, 0x8A));
    public static readonly Brush High = Freeze(Color.FromRgb(0xF2, 0xB3, 0x3D));
    public static readonly Brush Low = Freeze(Color.FromRgb(0xEF, 0x53, 0x50));
    public static readonly Brush Stale = Freeze(Color.FromRgb(0x77, 0x7B, 0x84));

    public static Brush BrushFor(int mgdl, int low, int high) =>
        mgdl < low ? Low : mgdl > high ? High : InRange;

    public static string Format(int mgdl, bool mmol)
    {
        if (mgdl <= 39) return "LOW";
        if (mgdl >= 401) return "HIGH";
        return mmol ? (mgdl / MmolFactor).ToString("0.0", CultureInfo.CurrentCulture) : mgdl.ToString(CultureInfo.CurrentCulture);
    }

    public static string FormatDelta(int deltaMgdl, bool mmol)
    {
        var text = mmol
            ? (deltaMgdl / MmolFactor).ToString("+0.0;-0.0;0.0", CultureInfo.CurrentCulture)
            : deltaMgdl.ToString("+0;-0;0", CultureInfo.CurrentCulture);
        return text;
    }

    public static string Arrow(string trend) => trend switch
    {
        "DoubleUp" => "⇈",
        "SingleUp" => "↑",
        "FortyFiveUp" => "↗",
        "Flat" => "→",
        "FortyFiveDown" => "↘",
        "SingleDown" => "↓",
        "DoubleDown" => "⇊",
        "NotComputable" or "RateOutOfRange" => "?",
        _ => "",
    };

    public static string Units(bool mmol) => mmol ? "mmol/L" : "mg/dL";

    static Brush Freeze(Color c)
    {
        var b = new SolidColorBrush(c);
        b.Freeze();
        return b;
    }
}
