# MIRU native preview

C# / .NET 10 + WinUI 3 への段階的な移行。**これはnative shellの最初の区切りで、既存TypeScript版との機能同等性を達成したものではありません。** TypeScriptの作成済み成果は先に保存・統合し、移行の仕様と回帰基準として残します。

## 責務

- `Miru.Cli`: argv、WSL→Windows変換、GUI起動。shell文字列を組み立てない。
- `Miru.Core`: path/scope/opaque ID、有限の列挙・検索・読取。WinUI・HTTP・HTMLに依存しない。
- `Miru.Documents`: bounded Markdown ASTと有限の行比較を実行能力のない表示データへ変換。filesystem・WinUIへ依存しない。
- `Miru.Git`: local-only/read-only statusとraw blob比較service。[境界と非対応](docs/git-view.md)を参照。
- `Miru.App`: WinUIの表示・操作。filesystem操作はCoreへ、遅いI/OはUI thread外で直列化。サーバ・localhost port・Node runtimeなし。

### この区切りに含むもの

- HOME launcher、明示path、folder treeの遅延展開、親へ/選択folderをtopへ、Refresh。
- HOMEの有限検索。部分的な結果や打ち切りを表示し、1件だけでも一意性と推測しない。
- UTF-8/UTF-16のread-only source（2 MiB上限）。HTML/SVGもtextのみで、script・link・image URLを解釈しない。
- Markdownのnative Preview/Source切替。見出し・強調・表・task list等のGFM-oriented subset。HTMLはtext、linkは非活性、imageはalt textのみ。[対応差分と安全境界](docs/markdown-preview.md)を参照。
- Repositoryの変更tree、Staged/Unstaged、符号・行番号付きのChangesと両側全文のVersions。ローカルWindows Gitに限定し、WSL Gitは明示拒否。FilesではGitを起動しません。
- VS Codeを参考にした左rail/Explorer/主view/細いstatus bar。GitHub Primer light/dark配色、OS初期theme、明示toggle、High Contrastはsystem色。
- Ctrl+Lでpath、F5でRefresh、Alt+Upで親、Ctrl+HomeでHOME。native TreeViewの標準keyboard操作。

### まだ含まない必須機能

- 完全なGitHub表示互換、Mermaid、image/PDF/安全なHTML preview。Mermaid fenceはsource-onlyと未完表示します。
- WSLのGit bridge、Windows/WSL実機での起動・path・停止distro・大規模repo性能受入。
- Submoduleの状態表示。安全のためstagedの追加・更新・削除も一覧から省きます。空のファイル一覧をrepository全体のclean判定には使いません。

上記は削除された要件ではなく、後続移行の受入項目です。編集/ターミナル/拡張機構/自動更新/telemetry、実ファイルdrag & dropは作りません。D&Dは本人指示によりMVP対象外です。Mac版もこのWindows MVPには含みません。

## Build

Windows x64、.NET SDK 10.0.404、Windows App SDK 2.6.5。NuGetは公式nuget.orgだけを使い、direct依存を固定しています。WinUI buildはWindowsが必要です。LinuxでのCore試験をWindows build/GUI成功と言い換えません。

```powershell
dotnet run --project native/tests/Miru.Core.Tests/Miru.Core.Tests.csproj -c Release
dotnet run --project native/tests/Miru.Documents.Tests/Miru.Documents.Tests.csproj -c Release
dotnet run --project native/tests/Miru.Git.Tests/Miru.Git.Tests.csproj -c Release
./native/scripts/publish.ps1
./native/artifacts/miru-windows-x64/miru.exe --help
./native/artifacts/miru-windows-x64/miru.exe C:\Users\you\Documents
```

Unpackaged/self-containedの**folder一式**を配布します。署名/installer/registry/PATH変更はしません。単体exeだけを移動しないでください。依存のruntimeを同梱し、初回起動時のdownloadに頼らない構成です。署名とWindowsの警告表示は配布前の別判断です。

WSL側のCLIはLinux .NET 10でビルドし、`MIRU_APP_PATH=/mnt/c/.../Miru.App.exe`を明示して使用する設計です。`wslpath -w`でtargetとHOMEを変換するため、Windows側のHOMEへ黙って差し替えません。Windows `.exe` にLinux argvをそのまま渡すことを対応済みとはしません。

```bash
dotnet run --project native/src/Miru.Cli -- --help
MIRU_APP_PATH=/mnt/c/path/to/Miru.App.exe dotnet run --project native/src/Miru.Cli -- /home/you/project
```

## 安全境界と制限

- 読取専用。明示Open/Home/Parent/Top/Search結果だけがscopeを移動します。navigation/Refreshで古IDは失効。
- 一般のnetwork UNC、mapped network drive、device path、ADS、曖昧なWindows aliasは拒否。WSLの明示distro UNCはローカルproviderとして区別します。
- この段階ではsymlink/junctionを追跡しません。表示されたlinkは理由を示して開きません。Unicode/spaceにshell解釈を加えません。
- 未到達/停止中WSLのOS I/Oには時間がかかる可能性があります。UIはworkerへ移しますが、OS filesystem callのhard timeoutや停止distroの自動起動を保証しません。
- 開発時のSDK/NuGet restoreと、利用時のファイル閲覧を区別します。MIRUのこのnative shellにはHTTP client・WebView・外部URI起動処理がありません。
- 静的link/junction拒否とopened handleのscope再照合は、敵対的な別processが親directoryを同時置換する場合までatomicに保護するsandboxではありません。OSのWSL provider metadata通信がゼロという保証でもありません。詳細は[Core境界](docs/core-and-wsl.md)を参照してください。

## 検証の分類

- Linux: Core/CLI/Documents/Git buildとfinite self-test。Windows専用分岐はWindows CI/実機で別検証。
- Windows CI: Core/Documents/Git self-test、WinUI compile/publish、packaged CLI `--help`。**GUI launch・screenshot・操作試験ではありません。**
- `python native/tests/verify_shell.py`: XML/readonly/無効D&D/ラベルと16個の色contrast組合せ。pixel QAや完全なaccessibility検査ではありません。
- 未完の実機受入: Windows/WSLからの起動、空白/日本語/長いpath、distro UNC、停止distro、tree/Refreshの反復、大きなfolder/source、100/150/200% DPI、narrow window、Narrator/keyboard、Light/Dark/High Contrast。

## UIの一次情報と採用判断

確認日: 2026-11-15。VS Codeの[公式UI構成](https://code.visualstudio.com/docs/editing/getting-started/userinterface)からExplorer/主view/statusの空間構成だけを参考にし、editor/terminal/extensionsは持ち込みません。

[Primerのsemantic color](https://primer.style/product/primitives/color/)と[light](https://github.com/primer/primitives/blob/main/src/tokens/base/color/light/light.json5) / [dark](https://github.com/primer/primitives/blob/main/src/tokens/base/color/dark/dark.json5)のbase値を確認。背景/文字/境界/強調の役割をXAML resourceへ対応させています。Lightのcanvas `#ffffff` / secondary `#f6f8fa`、Darkのcanvas `#0d1117` / secondary `#151b23`を基調にし、余白と細いborderで階層をつけます。

[WinUI theming](https://learn.microsoft.com/en-us/windows/apps/develop/ui/theming)、[TreeView](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/tree-view)、[unpackaged deployment](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/unpackage-winui-app?tabs=csharp)、[Windows App SDK 2.6.5](https://github.com/microsoft/WindowsAppSDK/releases/tag/v2.6.5)を参照。速度はnativeという名称だけで保証せず、実機で起動・展開・読取時間を測って判断します。
