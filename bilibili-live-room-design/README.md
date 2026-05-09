# Bilibili 4K SC2 Live Room Design

## 线上 API MMR

这个分支新增了 SC2 Pulse 线上 MMR 查询。服务启动后会自动生成 `mmr-api-config.json`，现在可以直接在控制台勾选 `启用线上MMR`，填写账号或使用最近一盘 replay 自动识别账号，不需要手动改配置文件或重启。手动账号优先，填入完整 `2-S2-1-3141896` 这类 toonHandle、包含它的 SC2 Pulse 链接，或 `battlenet:://starcraft/profile/...` 资料链接即可；清空手动账号后会重新使用 replay 自动识别。默认查询 `LOTV_1V1` 当前 rating；查不到线上数据时会保留原来的 replay/manual MMR，不会把直播画面刷空。

控制台里有 `启用线上MMR`、账号、种族、刷新间隔和 `刷新线上MMR` 按钮，也会显示线上 API 当前状态。设置会保存到 `mmr-api-config.json`，配置示例见 `mmr-api-config.example.json`。SC2 Pulse 数据来自公开天梯索引，使用时请保留对 `https://sc2pulse.nephest.com/sc2` 的来源说明。国服 `5-S2-...` 账号如果 SC2 Pulse 没有数据，工具会明确提示并继续保留原 MMR。

如果线上 API 更新不及时，或者国服 replay 里的自身 MMR 显示成固定 `2800` / 异常负数，可以在控制台打开 `Replay MMR估算`。它不是暴雪官方精确公式，也不会用你当前未定级账号的录像做校准；默认参数来自 SC2 Pulse 公开逐局 `ratingChange` 样本拟合：K 值约 `44`，分差尺度约 `850`。它会用 replay 里的对手 MMR、胜负和你当前显示的 `当前MMR` 做连续估算；先在 `当前MMR` 手动填一个大概值会更准。

这套按 `3840 x 2160` 设计，适合 OBS 里作为透明叠加层使用。风格是“星灵金蓝科幻 HUD”，避免直接使用游戏素材，降低侵权和画面冲突风险。

## 文件

- `overlay-competitive.svg`：认真打天梯用，低遮挡。
- `overlay-show.svg`：互动直播用，底部有通讯栏。
- `obs-browser-source.html`：OBS 浏览器源入口，默认加载 `overlay-competitive.svg`。
- `livehime-stats.html`：直播姬可用的本地网页统计面板，包含直播时长、场数、胜负、胜率、连胜/连败。
- `livehime-stats-server.js`：更适合直播姬的本地同步版，直播姬显示页和控制页实时同步。
- `start-livehime-stats.bat`：双击启动本地同步版。
- `replay-config.json`：首次启动后自动生成，用来配置 SC2 回放监听目录。

## OBS 使用

1. 添加 `浏览器源`。
2. 勾选 `本地文件`，选择 `obs-browser-source.html`。
3. 宽度填 `3840`，高度填 `2160`。
4. 如果要换展示版，在浏览器源本地文件后面加参数不太方便，所以也可以直接把 HTML 里的默认图改成 `overlay-show.svg`。如果用普通浏览器预览，访问 `obs-browser-source.html?mode=show` 可以切展示版。

## 直播姬统计面板使用

推荐用本地同步版：

1. 双击 `start-livehime-stats.bat`，保持黑色窗口开着。
2. 在直播姬里添加 `网页源`，地址填 `http://127.0.0.1:27392/view`。
3. 网页源宽度建议 `1240`，高度建议 `155`。想放底部黑区可以整体缩到 `1050 x 130` 左右。
4. 用浏览器打开 `http://127.0.0.1:27392/control` 作为控制台。
5. 控制台快捷键：`W` 记一胜，`L` 记一负，`U` 撤销，`P` 暂停/继续计时，`R` 重置本次直播。

## 自动读取 SC2 回放

本地同步版会自动监听：

`C:\Users\你的用户名\Documents\StarCraft II`

检测到新的 `.SC2Replay` 后，工具会自动解析胜负、对手种族和当前 MMR。只要 `replay-config.json` 能识别你，工具会自动把本场记为胜/负，并累加 `vT / vZ / vP` 三个对抗比分。

如果没有识别出你是谁，HUD 的状态会变成 `回放待确认`。这时在控制台按：

- `W`：把这条 replay 记为胜利。
- `L`：把这条 replay 记为失败。
- `忽略回放`：不统计这条 replay。
- `扫最新`：如果工具启动晚了，手动扫描最近的新 replay，并尝试自动解析统计。

配置：

- `preferReplayFolderToonId`：默认 `true`，优先按 replay 所在账号目录识别你是谁，最适合自动监听。
- `playerToonIds`：你的 SC2 toon ID。作为非标准目录或手动扫描时的备用识别。
- `playerNames`：可选，写你的游戏名片段，例如 `["条码"]`。
- `autoRecordParsedResults`：`true` 时解析成功后自动记胜负。

控制台可改：

- 当前 MMR
- `vT` 胜负
- `vZ` 胜负
- `vP` 胜负
- 标题下方的滚动字幕
- 开关底部 `当前MMR / vT / vZ / vP` 信息条
- 调整非文字内容透明度，文字保持不透明
- 切换图标/主题样式：神族、人族、虫族、极简

直播画面不会自动显示上一局地图、时长或胜负关系；自动读取 replay 只负责统计胜负、MMR 和对抗比分。

标题下方的滚动字幕可以在控制台手动修改，也可以用接口接入外部动态文字：

- 浏览器或脚本访问：`http://127.0.0.1:27392/ticker?text=你的滚动字幕`
- POST JSON：`http://127.0.0.1:27392/ticker`，内容为 `{ "text": "你的滚动字幕" }`

直播画面底部信息条只显示：`当前MMR 5035 | vT 0-0 | vZ 0-1 | vP 0-0`，不会显示玩家 ID 或长名字。

依赖：自动解析使用 Python 包 `s2protocol`。本机已安装过；如果换机器，运行 `python -m pip install --user s2protocol`。

纯本地文件版也保留着，适合只在直播姬内部手动交互：

1. 在直播姬里添加 `网页源` 或类似的浏览器源。
2. 选择本地文件 `livehime-stats.html`，宽度建议 `920`，高度建议 `260`。
3. 把它放到游戏画面的右上角或底部黑色信息区。
4. 操作统计时，用浏览器打开 `livehime-stats.html?edit=1`，页面会显示按钮。
5. 快捷键：`W` 记一胜，`L` 记一负，`U` 撤销，`P` 暂停/继续计时，`R` 重置本次直播。
6. 想开播时重置计时，可以用普通浏览器打开一次 `livehime-stats.html?edit=1&start=now`。

可选参数：

- `?edit=1`：显示控制按钮。
- `?title=你的标题`：改标题，例如 `?title=星灵折跃频道`。
- `?matchup=当前 PvZ`：改副标题。
- `?start=now`：从当前时间重新开始计时。

## 布局原则

- 左下小地图不遮挡。
- 右上资源栏不遮挡。
- 右下命令卡不遮挡。
- 底部互动内容只放在游戏 UI 的黑色信息区，适合非高强度对局。

## 建议直播间命名

- 星灵折跃频道
- 今日目标：稳住二矿
- 舰队通讯频道
- 正在折跃主播
- 今日战绩：0-0

## B 站装修素材建议

- 封面：`星灵折跃频道 / 今日开门造水晶`
- 等待页：`正在折跃主播`
- 休息页：`正在补农民`
- 断线页：`通讯链路重连中`
- 关注提示：蓝色能量条 + `新的舰队成员`
- 礼物提示：矿晶/瓦斯风格小徽章 + 金色提示条
