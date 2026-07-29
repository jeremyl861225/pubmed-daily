# 每日文獻 · Daily Literature

每天一篇文獻導讀的離線閱讀站。論文 HTML 由 Claude cowork 在雲端每日產生，
推進 `papers/` 之後，索引、搜尋與離線快取全部自動重建。

網站：<https://jeremyl861225.github.io/pubmed-daily/>

## 怎麼運作

```
cowork 每天早上產生 pubmed-*.html
        │  （雲端直接 commit 進 papers/，不必開電腦）
        ▼
   papers/*.html  ──push──▶  GitHub Actions「建索引」
                                 │  python3 build.py
                                 ├─ data/papers.json    首頁與搜尋的資料
                                 ├─ papers/*.html       注入「← 文獻列表」返回鍵
                                 └─ sw.js               預快取清單＋內容指紋
                                 ▼
                            GitHub Pages 發佈
                                 ▼
                     手機開啟／下拉更新 → 全站離線可讀
```

備援：`scripts/import-from-cowork.sh` 由 launchd（`com.jeremy.pubmed-daily-import`）
監看本機 cowork 資料夾，Mac 開著時若發現雲端那條沒推成功，會自動補推。
兩條路徑重複匯入同一篇不會出問題（檔名相同就覆蓋，索引重建後結果一樣）。

**這支備援需要一次性授權才會生效**：桌面受 macOS 隱私權保護，背景程式讀不到。
到 系統設定 › 隱私權與安全性 › 完全取用磁碟，按 `+` 加入 `/bin/bash`
（Finder 按 ⇧⌘G 輸入 `/bin` 找得到）。未授權時它只會在紀錄裡留一行提醒，不會誤判成「今天沒有新論文」。

安裝／檢查：

```bash
cp scripts/import-from-cowork.sh "$HOME/Library/Application Support/pubmed-daily/import.sh"
cp scripts/com.jeremy.pubmed-daily-import.plist ~/Library/LaunchAgents/   # 內含的路徑指向上面那份
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jeremy.pubmed-daily-import.plist
tail -5 "$HOME/Library/Application Support/pubmed-daily/import.log"       # 看它做了什麼
```

## 檔案

| 路徑 | 用途 |
| --- | --- |
| `index.html` `css/style.css` `js/app.js` | 首頁：吸頂查詢列、標籤篩選、下拉更新 |
| `papers/*.html` | 每天一篇的論文導讀，各自是完整獨立的 HTML |
| `data/papers.json` | 由 `build.py` 產生，勿手改 |
| `sw.js` | Service Worker：stale-while-revalidate；預快取清單由 `build.py` 改寫 |
| `build.py` | 建索引：解析論文欄位、注入返回鍵、更新快取清單 |
| `.github/workflows/build-index.yml` | `papers/` 一有變動就重建並 commit |

## 手動加一篇

```bash
cp 某篇.html papers/ && python3 build.py && git add papers data sw.js && git commit -m "新增論文" && git push
```

## 給 cowork routine 的指令（雲端直接匯入用）

把下面這段接在原本「產生每日論文 HTML」的指令後面：

> 產生完 HTML 後，用 GitHub connector 把檔案提交到 repo `jeremyl861225/pubmed-daily`
> 的 `main` 分支，路徑固定為 `papers/<檔名>.html`（檔名沿用 `pubmed-<主題>-<YYYY-MM-DD>.html`
> 格式，例如 `papers/pubmed-crs-2026-07-30.html`）。commit 訊息寫「新增論文：<日期> <中文標題>」。
> 只需提交這一個檔案，其餘索引檔（`data/papers.json`、`sw.js`）由 repo 內的 GitHub Actions
> 自動重建，不要自行修改。若同名檔案已存在就覆蓋。

論文 HTML 的版型請保持現有結構（`<h1 class="title">`、`<p class="title-en">`、
`<div class="meta-item">` 的期刊／作者／研究設計／DOI、`<span class="tag">`、
`id="tldr"` 一句話結論），`build.py` 就能正確抓出索引欄位；版型微調不會讓建索引失敗，
只是抓不到的欄位會留白。

## 同一個 origin 上的其他 PWA

`jeremyl861225.github.io` 上還有 Clinical-Tools 等站。本站 Service Worker 的
`activate` 只會刪掉 `pubmed-daily-` 前綴的快取，不會動到別站的離線內容。

## 授權

見 [LICENSE](LICENSE)。各篇論文之標題、摘要與圖表著作權歸原作者與期刊所有。
