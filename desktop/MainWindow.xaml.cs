using System.ComponentModel;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;

namespace GlucoWatch;

public partial class MainWindow : Window
{
    static readonly TimeSpan ReadingInterval = TimeSpan.FromMinutes(5);
    static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(15);

    readonly AppSettings settings = AppSettings.Load();
    readonly DispatcherTimer pollTimer = new();
    readonly DispatcherTimer ageTimer = new() { Interval = TimeSpan.FromSeconds(15) };
    DexcomClient? client;
    IReadOnlyList<GlucoseReading> readings = [];
    bool polling;
    bool fullScreen;
    WindowState preFullScreenState;

    public MainWindow()
    {
        InitializeComponent();
        RestorePlacement();

        SetTopmost(settings.Topmost);
        SetBigMode(settings.BigMode);
        (settings.ChartHours switch { 6 => Range6, 12 => Range12, 24 => Range24, _ => Range3 }).IsChecked = true;

        pollTimer.Tick += async (_, _) => await PollAsync();
        ageTimer.Tick += (_, _) => Render();
        Loaded += (_, _) =>
        {
            ageTimer.Start();
            Render();            if (settings.HasCredentials) StartClient();
            else OpenSettings();
        };
    }

    void StartClient()
    {
        pollTimer.Stop();
        client?.Dispose();
        client = new DexcomClient(settings.Username, settings.Password, settings.Region);
        readings = [];
        Render();
        _ = PollAsync();
    }

    async Task PollAsync()
    {
        var c = client;
        if (c is null || polling) return;
        polling = true;
        pollTimer.Stop();
        TimeSpan? next;
        try
        {
            StatusText.Text = "Updating…";
            var data = await c.GetReadingsAsync(1440, 288, CancellationToken.None);
            if (c != client) return;
            readings = data;
            StatusText.Text = $"Updated {DateTime.Now:t}";

            // Poll shortly after the next reading is expected to arrive.
            var wait = readings.Count > 0
                ? readings[^1].Time + ReadingInterval + TimeSpan.FromSeconds(20) - DateTimeOffset.Now
                : ReadingInterval;
            next = TimeSpan.FromTicks(Math.Clamp(wait.Ticks, TimeSpan.FromSeconds(30).Ticks, ReadingInterval.Ticks));
        }
        catch (DexcomException ex) when (ex.IsAuthError)
        {
            // Don't keep retrying bad credentials; Dexcom locks accounts after repeated failures.
            StatusText.Text = $"Sign-in failed: {ex.Message} Check settings.";
            next = null;
        }
        catch (Exception ex) when (ex is DexcomException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            StatusText.Text = ex is TaskCanceledException ? "Request timed out — retrying" : $"Error: {ex.Message}";
            next = TimeSpan.FromMinutes(1);
        }
        finally
        {
            polling = false;
        }

        if (c != client) return;
        Render();
        if (next is { } interval)
        {
            pollTimer.Interval = interval;
            pollTimer.Start();
        }
    }

    void Render()
    {
        var mmol = settings.UseMmol;
        UnitsText.Text = Glucose.Units(mmol);
        Chart.Update(readings, settings.ChartHours, settings.LowMgdl, settings.HighMgdl, mmol);

        if (readings.Count == 0)
        {
            ValueText.Text = BigValueText.Text = "---";
            ValueText.Foreground = BigValueText.Foreground = Glucose.Stale;
            TrendText.Text = DeltaText.Text = AgeText.Text = BigTrendText.Text = "";
            BigDetailText.Text = DateTime.Now.ToString("t");
            Title = "GlucoseAnywhere";
            return;
        }

        var latest = readings[^1];
        var age = DateTimeOffset.Now - latest.Time;
        var stale = age > StaleAfter;

        ValueText.Text = Glucose.Format(latest.Mgdl, mmol);
        ValueText.Foreground = stale ? Glucose.Stale : Glucose.BrushFor(latest.Mgdl, settings.LowMgdl, settings.HighMgdl);
        TrendText.Text = stale ? "" : Glucose.Arrow(latest.Trend);
        TrendText.Foreground = ValueText.Foreground;
        ValueText.TextDecorations = stale ? TextDecorations.Strikethrough : null;

        var previous = readings.Count > 1 ? readings[^2] : null;
        DeltaText.Text = previous is not null && latest.Time - previous.Time <= TimeSpan.FromMinutes(10)
            ? Glucose.FormatDelta(latest.Mgdl - previous.Mgdl, mmol)
            : "";

        AgeText.Text = age.TotalMinutes < 1 ? "just now" : $"{(int)age.TotalMinutes} min ago";

        BigValueText.Text = ValueText.Text;
        BigValueText.Foreground = BigTrendText.Foreground = ValueText.Foreground;
        BigValueText.TextDecorations = ValueText.TextDecorations;
        BigTrendText.Text = TrendText.Text;
        BigDetailText.Text = string.Join("  ·  ", new[]
        {
            DeltaText.Text.Length > 0 ? $"{DeltaText.Text} {UnitsText.Text}" : UnitsText.Text,
            AgeText.Text,
            DateTime.Now.ToString("t"),
        });
        Title = stale
            ? $"{ValueText.Text} (old) – GlucoseAnywhere"
            : $"{ValueText.Text} {TrendText.Text} – GlucoseAnywhere";
    }

    void OpenSettings()
    {
        var dialog = new SettingsWindow(settings) { Owner = this };
        if (dialog.ShowDialog() == true)
        {
            settings.Save();
            if (dialog.CredentialsChanged || client is null) StartClient();
            else Render();
        }
        else if (!settings.HasCredentials)
        {
            StatusText.Text = "Open settings to sign in";
        }
    }

    void Range_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { Tag: string tag } && int.TryParse(tag, out var hours))
        {
            settings.ChartHours = hours;
            if (IsLoaded) Render();
        }
    }

    void Refresh_Click(object sender, RoutedEventArgs e)
    {
        if (client is null) OpenSettings();
        else _ = PollAsync();
    }

    void Pin_Click(object sender, RoutedEventArgs e) => SetTopmost(PinButton.IsChecked == true);

    void PinMenuItem_Click(object sender, RoutedEventArgs e) => SetTopmost(PinMenuItem.IsChecked);

    void BigMenuItem_Click(object sender, RoutedEventArgs e) => SetBigMode(!settings.BigMode);

    void FullScreenMenuItem_Click(object sender, RoutedEventArgs e) => SetFullScreen(!fullScreen);

    void Settings_Click(object sender, RoutedEventArgs e) => OpenSettings();

    void Root_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2 && e.OriginalSource is not ButtonBase)
        {
            SetBigMode(!settings.BigMode);
            e.Handled = true;
        }
    }

    void Window_KeyDown(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.F11: SetFullScreen(!fullScreen); break;
            case Key.Escape when fullScreen: SetFullScreen(false); break;
            case Key.F5: Refresh_Click(sender, e); break;
            default: return;
        }
        e.Handled = true;
    }

    void SetTopmost(bool on)
    {
        Topmost = settings.Topmost = on;
        PinButton.IsChecked = PinMenuItem.IsChecked = on;
    }

    void SetBigMode(bool on)
    {
        settings.BigMode = BigMenuItem.IsChecked = on;
        BigView.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        NormalView.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
    }

    void SetFullScreen(bool on)
    {
        if (on == fullScreen) return;
        fullScreen = FullScreenMenuItem.IsChecked = on;
        if (on)
        {
            preFullScreenState = WindowState;
            // Must leave Maximized first, or a borderless maximize won't cover the taskbar.
            WindowState = WindowState.Normal;
            WindowStyle = WindowStyle.None;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowStyle = WindowStyle.SingleBorderWindow;
            WindowState = preFullScreenState;
        }
    }

    void RestorePlacement()
    {
        if (settings.Width is { } w && settings.Height is { } h)
        {
            Width = Math.Max(MinWidth, w);
            Height = Math.Max(MinHeight, h);
        }
        if (settings.Left is { } left && settings.Top is { } top)
        {
            // Only restore the position if the window would still be on a visible screen.
            var screen = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
                SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
            if (screen.IntersectsWith(new Rect(left, top, Width, 40)))
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = left;
                Top = top;
            }
        }
    }

    void Window_Closing(object? sender, CancelEventArgs e)
    {
        var bounds = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        settings.Left = bounds.Left;
        settings.Top = bounds.Top;
        settings.Width = bounds.Width;
        settings.Height = bounds.Height;
        settings.Save();
        client?.Dispose();
    }
}
