# Windows / WSL 実機 smoke

この手順は **未実施の受入項目** です。CIのbuild・self-test・publish成功とは区別します。実機結果を記録するまで合格扱いにしません。

## 準備

配布物はfolder一式を展開し、`miru.exe` / `Miru.App.exe` と依存DLL・`third_party`を一緒に置きます。Git表示には既存の対応Git for Windowsが必要です。MIRUはGitやfontを自動取得しません。以下では個人データではなく使い捨てのフォルダ・Git作業コピーを使います。

配布内の`examples/native-smoke.md`（ソースでは`native/tests/fixtures/native-smoke.md`）を開くと、GFM、2種類の対応図、未対応図、非活性のリンク・画像を一度に確認できます。

## 最小の確認

| 確認                 | 操作と合格条件                                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 起動・到達        | 無引数でHOME。空白・日本語を含む実在file/folderをCLIの1引数またはOpenで開く。親へ、下のfolderをtopへ、HOMEへ戻る。表示pathと対象が一致し、入力やtreeを連打しても別の古い内容が現れない。                                                                                                                                               |
| 2. Markdown・Mermaid | smokeファイルをPreview/Sourceで切替。flowchartとsequenceの文字・箱・接続線、特に日本語を実画面で確認。未対応pieは理由とsourceを表示。Light/Darkを反復し、描画中にRepository/HOME/別fileへ移動して閉じる。古い図が戻らず、別windowやbrowserが開かない。High Contrastでは図をsource-onlyにする。                                         |
| 3. Gitと閲覧専用     | 使い捨てrepoに、内容がそれぞれ`HEAD`・`INDEX`・`WORKING`と分かる1ファイルを用意。StagedはHEAD→INDEX、UnstagedはINDEX→WORKING。Changes/Versions、別file、Refresh、Filesを反復し、ラベルと本文が一致する。MIRUの操作前後でそのfileと`.git/index`のhashが変わらない。submoduleはstagedも省略され、空表示はrepo全体のclean判定ではない。   |
| 4. WSL境界           | 稼働中のテスト用distroでLinux版CLI→Windows Appを試し、Linuxの対象・HOMEが保たれることを確認。明示WSL UNCでFilesが開き、Repositoryは未対応理由を表示してWindows Gitへ黙って切り替わらない。Windows exeへLinux pathを直接渡す経路は自動変換対応ではない。停止distroは専用テスト環境だけで確認し、待ち時間・復帰/終了の可否を別記録する。 |
| 5. 読みやすさ・待ち  | 100/150/200% DPI、狭いwindow、keyboard/Narratorでpath/tree/Source/図source/比較を辿る。Light/Dark/High Contrastの文字と符号が読める。大きなfolder/repoでは制限の説明があり、遅いI/O中もwindowを閉じられる。起動・展開・読取の実測時間を残し、nativeという理由だけで高速と判定しない。                                                  |

リンクや画像が無効であることの画面確認は、OS全体の無通信証明ではありません。MIRUは外部URIを渡さず、図は同梱rendererのmemory PNGのみを受け取ります。OSのWSL providerやfont/native library動作、同一ユーザーの別processによるfilesystem差替えまで完全sandboxとはしません。

## 記録

`commit / Windows build / Git version / distro・状態 / DPI / 1〜5のPass・Fail・未実施 / 失敗手順 / screenshot / 実測時間`だけを記録してください。private fileの本文やアクセス情報を共有する必要はありません。表示だけで確認できない境界は自動の有限テストと合わせて判断します。
