using System.Globalization;
using System.Windows;
using System.Windows.Controls;

namespace GlucoWatch;

public partial class SettingsWindow : Window
{
    readonly AppSettings settings;
    bool unitsMmol;

    public bool CredentialsChanged { get; private set; }

    public SettingsWindow(AppSettings settings)
    {
        InitializeComponent();
        this.settings = settings;

        UsernameBox.Text = settings.Username;
        if (settings.HasCredentials)
            PasswordBox.ToolTip = "Leave blank to keep the saved password";
        RegionBox.SelectedIndex = (int)settings.Region;

        unitsMmol = settings.UseMmol;
        LowBox.Text = FormatThreshold(settings.LowMgdl);
        HighBox.Text = FormatThreshold(settings.HighMgdl);
        UnitsBox.SelectedIndex = unitsMmol ? 1 : 0;
    }

    void UnitsBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var mmol = UnitsBox.SelectedIndex == 1;
        if (mmol == unitsMmol || LowBox is null) return;

        // Convert the thresholds already typed so they keep their meaning.
        var low = ParseThreshold(LowBox.Text);
        var high = ParseThreshold(HighBox.Text);
        unitsMmol = mmol;
        if (low is { } l) LowBox.Text = FormatThreshold(l);
        if (high is { } h) HighBox.Text = FormatThreshold(h);
    }

    void Save_Click(object sender, RoutedEventArgs e)
    {
        var username = UsernameBox.Text.Trim();
        var password = PasswordBox.Password;
        var low = ParseThreshold(LowBox.Text);
        var high = ParseThreshold(HighBox.Text);

        string? error =
            username.Length == 0 ? "Enter your Dexcom username." :
            password.Length == 0 && !settings.HasCredentials ? "Enter your Dexcom password." :
            low is null || high is null ? "Enter valid low and high thresholds." :
            low < 40 || high > 400 || low >= high ? "Thresholds must be between 40 and 400 mg/dL, with low below high." :
            null;

        if (error is not null)
        {
            ErrorText.Text = error;
            ErrorText.Visibility = Visibility.Visible;
            return;
        }

        var region = (DexcomRegion)RegionBox.SelectedIndex;
        CredentialsChanged = username != settings.Username || password.Length > 0 || region != settings.Region;

        settings.Username = username;
        if (password.Length > 0) settings.Password = password;
        settings.Region = region;
        settings.UseMmol = unitsMmol;
        settings.LowMgdl = low!.Value;
        settings.HighMgdl = high!.Value;
        DialogResult = true;
    }

    string FormatThreshold(int mgdl) => unitsMmol
        ? (mgdl / Glucose.MmolFactor).ToString("0.0", CultureInfo.CurrentCulture)
        : mgdl.ToString(CultureInfo.CurrentCulture);

    /// <summary>Parses a threshold in the currently selected units and returns it in mg/dL.</summary>
    int? ParseThreshold(string text)
    {
        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.CurrentCulture, out var value)) return null;
        return (int)Math.Round(unitsMmol ? value * Glucose.MmolFactor : value);
    }
}
