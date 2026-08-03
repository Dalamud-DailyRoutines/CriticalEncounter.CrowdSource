using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace InstanceFinder;

internal static class Program
{
    private const long CTRL_C_WINDOW_MS = 2_000;

    private static readonly Language[] Languages =
    [
        new
        (
            "简体中文",
            [
                "检测到多个 ffxiv_dx11.exe 进程，请选择：", "请输入序号：", "未找到 ffxiv_dx11.exe 进程。",
                "已选择 ffxiv_dx11.exe（PID {0}）。", "副本实例 ID：{0}", "无法定位当前游戏版本所需的特征码。",
                "无法读取所选游戏进程。", "读取副本实例 ID 失败。", "按任意键再次读取；连续按两次 Ctrl+C 退出。",
                "请再次按 Ctrl+C 退出。", "所选游戏进程已退出。"
            ]
        ),
        new
        (
            "日本語",
            [
                "複数の ffxiv_dx11.exe プロセスが見つかりました。選択してください：", "番号を入力してください：", "ffxiv_dx11.exe プロセスが見つかりません。",
                "ffxiv_dx11.exe（PID {0}）を選択しました。", "インスタンス ID：{0}", "現在のゲームバージョンに対応するシグネチャが見つかりません。",
                "選択したゲームプロセスを読み取れません。", "インスタンス ID の読み取りに失敗しました。", "任意のキーで再度読み取ります。Ctrl+C を 2 回続けて押すと終了します。",
                "終了するには、もう一度 Ctrl+C を押してください。", "選択したゲームプロセスは終了しました。"
            ]
        ),
        new
        (
            "English",
            [
                "Multiple ffxiv_dx11.exe processes were found. Select one:", "Enter a number: ", "No ffxiv_dx11.exe process was found.",
                "Selected ffxiv_dx11.exe (PID {0}).", "Instance ID: {0}", "The signatures required for this game version could not be found.",
                "The selected game process could not be read.", "Failed to read the instance ID.", "Press any key to read again; press Ctrl+C twice in succession to exit.",
                "Press Ctrl+C again to exit.", "The selected game process has exited."
            ]
        ),
        new
        (
            "Deutsch",
            [
                "Mehrere ffxiv_dx11.exe-Prozesse wurden gefunden. Bitte auswählen:", "Nummer eingeben: ", "Kein ffxiv_dx11.exe-Prozess wurde gefunden.",
                "ffxiv_dx11.exe (PID {0}) wurde ausgewählt.", "Instanz-ID: {0}", "Die Signaturen für diese Spielversion wurden nicht gefunden.",
                "Der ausgewählte Spielprozess konnte nicht gelesen werden.", "Die Instanz-ID konnte nicht gelesen werden.", "Beliebige Taste drücken, um erneut zu lesen; Ctrl+C zweimal hintereinander drücken, um das Programm zu beenden.",
                "Ctrl+C erneut drücken, um das Programm zu beenden.", "Der ausgewählte Spielprozess wurde beendet."
            ]
        ),
        new
        (
            "Français",
            [
                "Plusieurs processus ffxiv_dx11.exe ont été détectés. Sélectionnez-en un :", "Saisissez le numéro : ", "Aucun processus ffxiv_dx11.exe n'a été trouvé.",
                "ffxiv_dx11.exe (PID {0}) sélectionné.", "ID d'instance : {0}", "Les signatures requises pour cette version du jeu sont introuvables.",
                "Impossible de lire le processus du jeu sélectionné.", "Échec de la lecture de l'ID d'instance.", "Appuyez sur une touche pour relire ; appuyez deux fois de suite sur Ctrl+C pour quitter.",
                "Appuyez de nouveau sur Ctrl+C pour quitter.", "Le processus du jeu sélectionné s'est arrêté."
            ]
        ),
        new
        (
            "한국어",
            [
                "ffxiv_dx11.exe 프로세스가 여러 개 발견되었습니다. 선택하세요:", "번호를 입력하세요: ", "ffxiv_dx11.exe 프로세스를 찾을 수 없습니다.",
                "ffxiv_dx11.exe(PID {0})를 선택했습니다.", "인스턴스 ID: {0}", "현재 게임 버전에 필요한 시그니처를 찾을 수 없습니다.",
                "선택한 게임 프로세스를 읽을 수 없습니다.", "인스턴스 ID를 읽지 못했습니다.", "아무 키나 누르면 다시 읽습니다. 종료하려면 Ctrl+C를 연속으로 두 번 누르세요.",
                "종료하려면 Ctrl+C를 한 번 더 누르세요.", "선택한 게임 프로세스가 종료되었습니다."
            ]
        )
    ];

    private static Language language = Languages[0];
    private static long     lastCtrlCTimestamp;

    public static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title          = "InstanceFinder";
        language               = SelectLanguage();
        Console.CancelKeyPress += OnCancelKeyPress;

        while (true)
        {
            using var process = SelectProcess();
            if (process is null)
            {
                Console.WriteLine(language[Message.NoProcess]);
                if (!WaitForRetry()) return;

                continue;
            }

            Console.WriteLine(language.Format(Message.SelectedProcess, process.Id));

            try
            {
                using var game = new GameProcess(process);

                while (!game.HasExited)
                {
                    try
                    {
                        Console.WriteLine(language.Format(Message.ZoneServerID, game.ReadZoneServerID()));
                    }
                    catch (Win32Exception)
                    {
                        if (game.HasExited) break;

                        Console.WriteLine(language[Message.ReadFailed]);
                    }

                    if (!WaitForRetry()) return;
                }

                Console.WriteLine(language[Message.ProcessExited]);
            }
            catch (KeyNotFoundException)
            {
                Console.WriteLine(language[Message.SignatureNotFound]);
            }
            catch (Win32Exception)
            {
                Console.WriteLine(language[Message.AccessFailed]);
            }
            catch (InvalidDataException)
            {
                Console.WriteLine(language[Message.ReadFailed]);
            }
            catch (InvalidOperationException)
            {
                Console.WriteLine(language[Message.ProcessExited]);
            }

            if (!WaitForRetry()) return;
        }
    }

    private static Language SelectLanguage()
    {
        Console.WriteLine("请选择语言 / 言語を選択 / Select language / Sprache wählen / Choisir la langue / 언어를 선택하세요");

        for (var index = 0; index < Languages.Length; index++)
            Console.WriteLine($"[{index + 1}] {Languages[index].Name}");

        while (true)
        {
            Console.Write("> ");
            var input = Console.ReadLine();
            ResetCtrlC();

            if (int.TryParse(input, out var selection) && selection >= 1 && selection <= Languages.Length)
                return Languages[selection - 1];
        }
    }

    private static Process? SelectProcess()
    {
        var processes = Process.GetProcessesByName("ffxiv_dx11").OrderBy(process => process.Id).ToArray();
        if (processes.Length == 0) return null;
        if (processes.Length == 1) return processes[0];

        Console.WriteLine(language[Message.SelectProcess]);

        for (var index = 0; index < processes.Length; index++)
        {
            var title = processes[index].MainWindowTitle;
            var label = string.IsNullOrWhiteSpace(title) ? $"PID {processes[index].Id}" : $"PID {processes[index].Id} - {title}";
            Console.WriteLine($"[{index + 1}] {label}");
        }

        while (true)
        {
            Console.Write(language[Message.EnterSelection]);
            var input = Console.ReadLine();
            ResetCtrlC();

            if (!int.TryParse(input, out var selection) || selection < 1 || selection > processes.Length) continue;

            var selected = processes[selection - 1];
            foreach (var process in processes)
                if (process != selected)
                    process.Dispose();

            return selected;
        }
    }

    private static bool WaitForRetry()
    {
        Console.WriteLine(language[Message.Retry]);

        if (Console.IsInputRedirected)
        {
            var hasInput = Console.ReadLine() is not null;
            ResetCtrlC();
            return hasInput;
        }

        Console.ReadKey(true);
        ResetCtrlC();
        return true;
    }

    private static void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs eventArgs)
    {
        var timestamp = Environment.TickCount64;
        var previous  = Interlocked.Exchange(ref lastCtrlCTimestamp, timestamp);

        if (previous != 0 && timestamp - previous <= CTRL_C_WINDOW_MS) return;

        eventArgs.Cancel = true;
        Console.WriteLine();
        Console.WriteLine(language[Message.ConfirmExit]);
    }

    private static void ResetCtrlC() => Interlocked.Exchange(ref lastCtrlCTimestamp, 0);

    private enum Message
    {
        SelectProcess,
        EnterSelection,
        NoProcess,
        SelectedProcess,
        ZoneServerID,
        SignatureNotFound,
        AccessFailed,
        ReadFailed,
        Retry,
        ConfirmExit,
        ProcessExited
    }

    private sealed record Language(string Name, string[] Strings)
    {
        public string this[Message message] => Strings[(int)message];

        public string Format(Message message, object value) => string.Format(this[message], value);
    }
}
