# GWS スキル一覧

> `gws generate-skills` で自動生成後、日本語化したもの。

## Services（18個） — API操作の基本スキル

| スキル | 説明 |
|-------|------|
| [gws-shared](../skills/gws-shared/SKILL.md) | gws CLI共通パターン：認証・グローバルフラグ・出力形式 |
| [gws-drive](../skills/gws-drive/SKILL.md) | Google Drive：ファイル・フォルダ・共有ドライブの管理 |
| [gws-sheets](../skills/gws-sheets/SKILL.md) | Google Sheets：スプレッドシートの読み書き |
| [gws-gmail](../skills/gws-gmail/SKILL.md) | Gmail：メールの送受信・管理 |
| [gws-calendar](../skills/gws-calendar/SKILL.md) | Google Calendar：カレンダーとイベントの管理 |
| [gws-admin-reports](../skills/gws-admin-reports/SKILL.md) | Google Workspace管理：監査ログと使用状況レポート |
| [gws-docs](../skills/gws-docs/SKILL.md) | Google Docs：ドキュメントの読み書き |
| [gws-slides](../skills/gws-slides/SKILL.md) | Google Slides：プレゼンテーションの読み書き |
| [gws-tasks](../skills/gws-tasks/SKILL.md) | Google Tasks：タスクリストとタスクの管理 |
| [gws-people](../skills/gws-people/SKILL.md) | Google People：連絡先とプロフィールの管理 |
| [gws-chat](../skills/gws-chat/SKILL.md) | Google Chat：スペースとメッセージの管理 |
| [gws-classroom](../skills/gws-classroom/SKILL.md) | Google Classroom：クラス・名簿・課題の管理 |
| [gws-forms](../skills/gws-forms/SKILL.md) | Google Forms：フォームの読み書き |
| [gws-keep](../skills/gws-keep/SKILL.md) | Google Keep：ノートの管理 |
| [gws-meet](../skills/gws-meet/SKILL.md) | Google Meet：会議の管理 |
| [gws-events](../skills/gws-events/SKILL.md) | Google Workspace Events：イベントの購読 |
| [gws-modelarmor](../skills/gws-modelarmor/SKILL.md) | Model Armor：ユーザー生成コンテンツの安全フィルタリング |
| [gws-workflow](../skills/gws-workflow/SKILL.md) | Workflow：サービス横断の生産性ワークフロー |

## Helpers（20個） — よく使う操作のショートカット

| スキル | 説明 |
|-------|------|
| [gws-drive-upload](../skills/gws-drive-upload/SKILL.md) | Drive：ファイルアップロード（メタデータ自動付与） |
| [gws-sheets-append](../skills/gws-sheets-append/SKILL.md) | Sheets：スプレッドシートに行を追加 |
| [gws-sheets-read](../skills/gws-sheets-read/SKILL.md) | Sheets：スプレッドシートの値を読み取り |
| [gws-gmail-send](../skills/gws-gmail-send/SKILL.md) | Gmail：メール送信 |
| [gws-gmail-triage](../skills/gws-gmail-triage/SKILL.md) | Gmail：未読受信トレイの要約表示（送信者・件名・日付） |
| [gws-gmail-watch](../skills/gws-gmail-watch/SKILL.md) | Gmail：新着メール監視（NDJSONストリーム） |
| [gws-calendar-insert](../skills/gws-calendar-insert/SKILL.md) | Calendar：新しいイベントを作成 |
| [gws-calendar-agenda](../skills/gws-calendar-agenda/SKILL.md) | Calendar：全カレンダーの予定一覧を表示 |
| [gws-docs-write](../skills/gws-docs-write/SKILL.md) | Docs：ドキュメントにテキストを追記 |
| [gws-chat-send](../skills/gws-chat-send/SKILL.md) | Chat：スペースにメッセージを送信 |
| [gws-events-subscribe](../skills/gws-events-subscribe/SKILL.md) | Events：Workspaceイベントを購読（NDJSONストリーム） |
| [gws-events-renew](../skills/gws-events-renew/SKILL.md) | Events：購読の更新・再有効化 |
| [gws-modelarmor-sanitize-prompt](../skills/gws-modelarmor-sanitize-prompt/SKILL.md) | Model Armor：ユーザープロンプトの安全チェック |
| [gws-modelarmor-sanitize-response](../skills/gws-modelarmor-sanitize-response/SKILL.md) | Model Armor：モデル応答の安全チェック |
| [gws-modelarmor-create-template](../skills/gws-modelarmor-create-template/SKILL.md) | Model Armor：テンプレートの新規作成 |
| [gws-workflow-standup-report](../skills/gws-workflow-standup-report/SKILL.md) | Workflow：今日の会議＋未完了タスクでスタンドアップ要約 |
| [gws-workflow-meeting-prep](../skills/gws-workflow-meeting-prep/SKILL.md) | Workflow：次の会議の準備（議題・参加者・関連ドキュメント） |
| [gws-workflow-email-to-task](../skills/gws-workflow-email-to-task/SKILL.md) | Workflow：Gmailメッセージをタスクに変換 |
| [gws-workflow-weekly-digest](../skills/gws-workflow-weekly-digest/SKILL.md) | Workflow：週次ダイジェスト（今週の会議＋未読メール数） |
| [gws-workflow-file-announce](../skills/gws-workflow-file-announce/SKILL.md) | Workflow：DriveファイルをChatスペースで共有 |

## Personas（10個） — 役割別スキルバンドル

| スキル | 説明 |
|-------|------|
| [persona-exec-assistant](../skills/persona-exec-assistant/SKILL.md) | エグゼクティブ秘書：予定・受信トレイ・連絡の管理 |
| [persona-project-manager](../skills/persona-project-manager/SKILL.md) | プロジェクトマネージャー：タスク追跡・会議調整・ドキュメント共有 |
| [persona-hr-coordinator](../skills/persona-hr-coordinator/SKILL.md) | HR担当：オンボーディング・社内通知・社員連絡 |
| [persona-sales-ops](../skills/persona-sales-ops/SKILL.md) | 営業：商談追跡・電話予約・顧客連絡 |
| [persona-it-admin](../skills/persona-it-admin/SKILL.md) | IT管理者：セキュリティ監視・Workspace設定 |
| [persona-content-creator](../skills/persona-content-creator/SKILL.md) | コンテンツ制作者：コンテンツの作成・整理・配信 |
| [persona-customer-support](../skills/persona-customer-support/SKILL.md) | カスタマーサポート：チケット管理・対応・エスカレーション |
| [persona-event-coordinator](../skills/persona-event-coordinator/SKILL.md) | イベント企画：スケジュール・招待・物流管理 |
| [persona-team-lead](../skills/persona-team-lead/SKILL.md) | チームリード：朝会・タスク調整・チーム連絡 |
| [persona-researcher](../skills/persona-researcher/SKILL.md) | リサーチャー：参考文献・ノート・共同研究の管理 |

## Recipes（41個） — マルチステップの実行レシピ

| スキル | 説明 |
|-------|------|
| [recipe-label-and-archive-emails](../skills/recipe-label-and-archive-emails/SKILL.md) | 条件に合うGmailにラベルを付けてアーカイブ |
| [recipe-draft-email-from-doc](../skills/recipe-draft-email-from-doc/SKILL.md) | Google Docsの内容をメール本文として下書き作成 |
| [recipe-organize-drive-folder](../skills/recipe-organize-drive-folder/SKILL.md) | Driveフォルダ構造を作成してファイルを整理 |
| [recipe-share-folder-with-team](../skills/recipe-share-folder-with-team/SKILL.md) | Driveフォルダとその中身をチームメンバーに共有 |
| [recipe-email-drive-link](../skills/recipe-email-drive-link/SKILL.md) | Driveファイルを共有してリンクをメールで送信 |
| [recipe-create-doc-from-template](../skills/recipe-create-doc-from-template/SKILL.md) | Docsテンプレートをコピーして内容を記入・共有 |
| [recipe-create-expense-tracker](../skills/recipe-create-expense-tracker/SKILL.md) | 経費追跡用のスプレッドシートを作成 |
| [recipe-copy-sheet-for-new-month](../skills/recipe-copy-sheet-for-new-month/SKILL.md) | Sheetsのテンプレートタブを新月分に複製 |
| [recipe-block-focus-time](../skills/recipe-block-focus-time/SKILL.md) | カレンダーに集中時間ブロックを定期作成 |
| [recipe-reschedule-meeting](../skills/recipe-reschedule-meeting/SKILL.md) | 会議を別の時間に移動して参加者に自動通知 |
| [recipe-create-gmail-filter](../skills/recipe-create-gmail-filter/SKILL.md) | Gmailフィルタを作成（自動ラベル・スター・分類） |
| [recipe-schedule-recurring-event](../skills/recipe-schedule-recurring-event/SKILL.md) | 参加者付きの定期イベントを作成 |
| [recipe-find-free-time](../skills/recipe-find-free-time/SKILL.md) | 複数ユーザーの空き時間を検索して会議枠を見つける |
| [recipe-bulk-download-folder](../skills/recipe-bulk-download-folder/SKILL.md) | Driveフォルダ内の全ファイルを一括ダウンロード |
| [recipe-find-large-files](../skills/recipe-find-large-files/SKILL.md) | 容量を消費している大きなDriveファイルを特定 |
| [recipe-create-shared-drive](../skills/recipe-create-shared-drive/SKILL.md) | 共有ドライブを作成してメンバーを追加 |
| [recipe-log-deal-update](../skills/recipe-log-deal-update/SKILL.md) | 営業追跡シートに商談状況を追記 |
| [recipe-collect-form-responses](../skills/recipe-collect-form-responses/SKILL.md) | Google Formsの回答を取得・確認 |
| [recipe-post-mortem-setup](../skills/recipe-post-mortem-setup/SKILL.md) | ポストモーテム：Docs作成→Calendarレビュー予約→Chat通知 |
| [recipe-create-task-list](../skills/recipe-create-task-list/SKILL.md) | 初期タスク付きの新しいタスクリストを作成 |
| [recipe-review-overdue-tasks](../skills/recipe-review-overdue-tasks/SKILL.md) | 期限切れのタスクを検索 |
| [recipe-watch-drive-changes](../skills/recipe-watch-drive-changes/SKILL.md) | Driveファイル・フォルダの変更通知を購読 |
| [recipe-create-classroom-course](../skills/recipe-create-classroom-course/SKILL.md) | Classroomコースを作成して生徒を招待 |
| [recipe-create-meet-space](../skills/recipe-create-meet-space/SKILL.md) | Meet会議スペースを作成して参加リンクを共有 |
| [recipe-review-meet-participants](../skills/recipe-review-meet-participants/SKILL.md) | Meet会議の参加者と参加時間を確認 |
| [recipe-create-presentation](../skills/recipe-create-presentation/SKILL.md) | 新しいSlidesプレゼンテーションを作成してスライド追加 |
| [recipe-save-email-attachments](../skills/recipe-save-email-attachments/SKILL.md) | Gmail添付ファイルをDriveフォルダに保存 |
| [recipe-send-team-announcement](../skills/recipe-send-team-announcement/SKILL.md) | GmailとChatの両方でチーム告知を送信 |
| [recipe-create-feedback-form](../skills/recipe-create-feedback-form/SKILL.md) | フィードバック用Formsを作成してGmailで共有 |
| [recipe-sync-contacts-to-sheet](../skills/recipe-sync-contacts-to-sheet/SKILL.md) | Google連絡先をスプレッドシートにエクスポート |
| [recipe-share-event-materials](../skills/recipe-share-event-materials/SKILL.md) | カレンダーイベントの参加者全員にDriveファイルを共有 |
| [recipe-create-vacation-responder](../skills/recipe-create-vacation-responder/SKILL.md) | Gmailの不在自動返信を設定（メッセージ・期間指定） |
| [recipe-create-events-from-sheet](../skills/recipe-create-events-from-sheet/SKILL.md) | Sheetsのデータからカレンダーイベントを一括作成 |
| [recipe-plan-weekly-schedule](../skills/recipe-plan-weekly-schedule/SKILL.md) | 週間カレンダーを確認して空き時間にイベントを追加 |
| [recipe-share-doc-and-notify](../skills/recipe-share-doc-and-notify/SKILL.md) | Docsを編集権限で共有してメールで通知 |
| [recipe-backup-sheet-as-csv](../skills/recipe-backup-sheet-as-csv/SKILL.md) | SheetsをCSVファイルとしてエクスポート |
| [recipe-save-email-to-doc](../skills/recipe-save-email-to-doc/SKILL.md) | Gmailメッセージ本文をDocsに保存（アーカイブ用） |
| [recipe-compare-sheet-tabs](../skills/recipe-compare-sheet-tabs/SKILL.md) | Sheetsの2つのタブを比較して差分を特定 |
| [recipe-batch-invite-to-event](../skills/recipe-batch-invite-to-event/SKILL.md) | カレンダーイベントに参加者を一括追加・通知 |
| [recipe-forward-labeled-emails](../skills/recipe-forward-labeled-emails/SKILL.md) | 特定ラベルのGmailを別アドレスに転送 |
| [recipe-generate-report-from-sheet](../skills/recipe-generate-report-from-sheet/SKILL.md) | Sheetsデータからフォーマット済みDocsレポートを生成 |
