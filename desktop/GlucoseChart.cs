using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace GlucoWatch;

/// <summary>Scatter chart of recent readings with the target range shaded.</summary>
public sealed class GlucoseChart : FrameworkElement
{
    const double AxisWidth = 30;
    const double TimeAxisHeight = 16;

    static readonly Typeface LabelFace = new("Segoe UI");
    static readonly Brush LabelBrush = Frozen(new SolidColorBrush(Color.FromRgb(0x80, 0x84, 0x8C)));
    static readonly Brush BandBrush = Frozen(new SolidColorBrush(Color.FromArgb(0x1E, 0x4C, 0xC3, 0x8A)));
    static readonly Pen GridPen = Frozen(new Pen(new SolidColorBrush(Color.FromArgb(0x22, 0xFF, 0xFF, 0xFF)), 1));
    static readonly Pen ThresholdPen = Frozen(new Pen(new SolidColorBrush(Color.FromArgb(0x55, 0xFF, 0xFF, 0xFF)), 1) { DashStyle = DashStyles.Dash });

    IReadOnlyList<GlucoseReading> readings = [];
    int hours = 3, low = 70, high = 180;
    bool mmol;

    public void Update(IReadOnlyList<GlucoseReading> readings, int hours, int low, int high, bool mmol)
    {
        this.readings = readings;
        this.hours = hours;
        this.low = low;
        this.high = high;
        this.mmol = mmol;
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        if (w < AxisWidth + 40 || h < TimeAxisHeight + 30) return;

        var plot = new Rect(0, 6, w - AxisWidth, h - 6 - TimeAxisHeight);
        var end = DateTimeOffset.Now;
        var start = end.AddHours(-hours);
        var visible = readings.Where(r => r.Time >= start).ToList();

        double yMin = 40;
        double yMax = Math.Min(400, Math.Max(250, visible.Count > 0 ? visible.Max(r => r.Mgdl) + 20 : 0));
        double Y(double mg) => plot.Bottom - (Math.Clamp(mg, yMin, yMax) - yMin) / (yMax - yMin) * plot.Height;
        double X(DateTimeOffset t) => plot.Left + (t - start).TotalSeconds / (hours * 3600.0) * plot.Width;

        // Target range band and threshold lines with labels.
        dc.DrawRectangle(BandBrush, null, new Rect(plot.Left, Y(high), plot.Width, Math.Max(0, Y(low) - Y(high))));
        foreach (var level in new[] { low, high })
        {
            var y = Math.Round(Y(level)) + 0.5;
            dc.DrawLine(ThresholdPen, new Point(plot.Left, y), new Point(plot.Right, y));
            DrawLabel(dc, Glucose.Format(level, mmol), new Point(plot.Right + 4, y), centerY: true);
        }

        // Vertical grid lines on whole hours.
        var step = hours <= 6 ? 1 : hours <= 12 ? 2 : 4;
        var tick = new DateTimeOffset(start.Year, start.Month, start.Day, start.Hour, 0, 0, start.Offset).AddHours(1);
        for (; tick < end; tick = tick.AddHours(1))
        {
            if (tick.Hour % step != 0) continue;
            var x = Math.Round(X(tick)) + 0.5;
            dc.DrawLine(GridPen, new Point(x, plot.Top), new Point(x, plot.Bottom));
            var label = tick.ToString("t", CultureInfo.CurrentCulture);
            var ft = MakeText(label);
            if (x - ft.Width / 2 >= 0 && x + ft.Width / 2 <= plot.Right)
                dc.DrawText(ft, new Point(x - ft.Width / 2, plot.Bottom + 2));
        }

        // Readings.
        var radius = hours <= 3 ? 3.0 : hours <= 6 ? 2.4 : hours <= 12 ? 2.0 : 1.6;
        foreach (var r in visible)
            dc.DrawEllipse(Glucose.BrushFor(r.Mgdl, low, high), null, new Point(X(r.Time), Y(r.Mgdl)), radius, radius);
    }

    void DrawLabel(DrawingContext dc, string text, Point at, bool centerY)
    {
        var ft = MakeText(text);
        dc.DrawText(ft, centerY ? new Point(at.X, at.Y - ft.Height / 2) : at);
    }

    FormattedText MakeText(string text) =>
        new(text, CultureInfo.CurrentCulture, FlowDirection.LeftToRight, LabelFace, 10, LabelBrush,
            VisualTreeHelper.GetDpi(this).PixelsPerDip);

    static T Frozen<T>(T f) where T : Freezable
    {
        f.Freeze();
        return f;
    }
}
