# Hatch Puppy Pet — 设计 Spec

日期：2026-06-10
状态：已批准，准备实现

## 背景

`docs/hatch-pet/` 是 OpenAI Codex 的 skill：用 `$imagegen` 从概念/参考图生成一只动画桌宠，
最终产出**一张 8×9 的透明 WebP 图集**（1536×1872，192×208 单元，9 行固定状态：idle、
running-right、running-left、waving、jumping、failed、waiting、running、review），打包进
`~/.codex/pets/<name>/`，由 Codex app 用 CSS background-position 播放。

GoodPuppy（本仓库）的渲染模型完全不同：`src/renderer.js` 用 `petImage.src =
/state_images/state_NN.gif` 切换**24 个独立的透明动画 GIF**（`state_01.gif`…`state_24.gif`，
240×240，3–14 帧，~90–140ms），`petState.js` 中 `stateCount = 24`。两者不兼容。

`docs/桌宠动画清单.md` 定义了 GoodPuppy 想要的语义动画。本 spec 把 Hatch Pet 改造成
**Hatch Puppy Pet**：保留其经过验证的工作流与画风/规则，仅替换动画集合与输出格式。

## 目标

将 `docs/hatch-pet/` 复刻为 `docs/hatch-puppy-pet/`（skill 名 `hatch-puppy-pet`），使其：

1. 产出**每状态一张 240×240 透明动画 GIF**（语义命名），而非单张图集。
2. 动画集合改为「桌宠动画清单」中状态为「待制作」的八项，含多子动作项拆分后共 **15 个动画**。
3. 画风与透明/伪影规则**与 Hatch Pet 完全一致**（Codex 像素风，规则不放宽）。
4. 身份来源仍是用户上传的参考图或文字概念（与现有 skill 一致）。

## 非目标

- 不改 GoodPuppy 的 `renderer.js` / `petState.js`。将语义 GIF 接入 `state_NN.gif`
  号码体系是单独的后续集成任务。
- 不做跨桌宠编排（谁踢谁、相对位置）——skill 只产单角色 GIF，配合由 app 负责。
- 不做清单中「暂缓」的 C004（羽毛球）、F001（节日），也不做未定义的 E001（开机）。

## 动画清单（替换原 9 行固定 Codex 状态）

15 个语义状态。每条定义 `name`、帧数、每帧时长、循环类型（loop / once）、动作说明。
帧数/时长为可在清单中编辑的起始默认值，参考现有 GIF（3–14 帧 @ ~90–140ms）。
loop 状态无限循环；once 状态播放一遍后**停留在末帧**（GIF 不写 loop 扩展），由 app
换 `src` 重新触发。

| 来源 | name | 帧 | 循环 | 说明 |
|---|---|---|---|---|
| A001 | `idle` | 6 | loop | 呼吸 + 眨眼中性循环；第 0 帧作为减少动态时的静态图 |
| A002 | `wander` | 8 | loop | 走来走去/踱步 |
| A002 | `sit-stand` | 6 | once | 坐下 → 起立 |
| B001 | `drag-trot` | 6 | loop | 被拖动时小跑 |
| C001 | `message` | 5 | once | 发消息手势 |
| C002 | `cuddle` | 6 | loop | 贴贴/蹭 |
| C002 | `feed` | 6 | loop | 喂食/进食 |
| C002 | `kicked` | 6 | once | 被踢飞（滑稽飞出弧线） |
| C003 | `enter-run` | 6 | once | 跑入房间 |
| C003 | `greet` | 4 | once | 别人进入时打招呼 |
| C003 | `leave-thrown` | 6 | once | 离开/被抛出 |
| D001 | `happy` | 6 | loop | 开心 |
| D001 | `sad` | 5 | loop | 难过 |
| D002 | `busy` | 6 | loop | 忙碌 |
| D002 | `bored` | 5 | loop | 无聊 |

## 画风与规则（与 Hatch Pet 相同，不改）

- **画风**：Codex 像素风小吉祥物——紧凑 chibi 比例、厚重深色 1–2px 轮廓、可见阶梯/像素
  边缘、有限调色板、扁平 cel 上色、简单可读的脸、细小四肢。上传参考图一律简化进这套画风。
- **透明/伪影规则不放宽**，照搬 Hatch Pet：禁止光晕/aura/投影、场景、文字、游离特效（漂浮
  星星、速度线、动作弧线、尘土、落地痕迹、独立烟雾团等）、色键及近色键溢色、跨格/裁切姿势。
  附着特效允许条件照搬（状态相关、不透明、硬边、像素风、同帧槽内、与本体接触/重叠）。
- **逐状态动作要求遵从上述规则**，只用姿势/表情/身体位置/四肢与道具运动表达：
  - `kicked`：身体倾斜/翻滚姿势序列，不画速度线、尘土、冲击爆发、轨迹。
  - `greet`：只用爪子姿势，不画波纹/星星/符号。
  - `feed`：用嘴/头部姿势表达咀嚼，不画游离食物碎屑或符号。允许一小块**贴着嘴部、
    不透明、硬边、像素风、同帧槽内**的食物（沿用 Hatch Pet 附着特效准则）；没有食物块
    的进食动画可读性差。
  - `sad` 的眼泪、`bored`/dizzy 的星星仅在附着本体、同帧槽内、不透明硬边时允许（沿用
    Hatch Pet 的 `failed` 规则）。

## 流程改动：图集 → 每状态 GIF

保留经过验证的流程骨架：准备运行目录 → imagegen 生成 base 身份参考 → 子代理逐状态生成帧条 →
帧提取 → QA 拼版 → 定稿 → 打包。子代理交接协议、身份锁定、布局参考图、色键、修复循环全部保留。

脚本层面：

- **保留并微调**：
  - `prepare_pet_run.py`：`ROWS` 替换为上面 15 个语义状态（含帧数/时长/循环/说明）；单元
    尺寸从 192×208 改为 **240×240**；为每状态生成 240×240 的布局参考图；任务清单仍每状态
    一个 row-strip job + 一个 base job。去掉 running-left 的镜像派生逻辑（新集合无此状态）。
  - `record_imagegen_result.py`、`extract_strip_frames.py`、`pet_job_status.py`、
    `queue_pet_repairs.py`、`inspect_frames.py`：随单元尺寸/状态名调整，逻辑不变。
- **替换**：
  - `compose_atlas.py` → `compose_gifs.py`：逐状态取提取出的帧，抠色键成透明，清理边缘，
    按该状态时长/循环装配成 **240×240 透明动画 GIF**，文件名用语义名（`idle.gif` 等）。
  - `validate_atlas.py` → `validate_gifs.py`：逐 GIF 校验尺寸（240×240）、帧数、透明度、调色板。
  - `package_custom_pet.py`：产出 `pet.json`（清单，含每状态 name/frames/durations/loop/
    file）+ 全部语义 GIF。
- **删除**：`derive_running_left_from_running_right.py`（无 running-left 状态）；
  `render_animation_videos.*`（产物本身就是动画 GIF，可直接预览，不再需要渲染 mp4 预览）。
- `make_contact_sheet.py`、`finalize_pet_run.py`：适配新产物
  （拼版图覆盖 15 状态；finalize 串起 compose_gifs + validate_gifs + QA + package）。

## 互动建模

所有动画均为**单角色**。C002（贴贴/喂食/踢飞）、C003（进入/打招呼/离开）涉及两只桌宠的语义，
但 skill 只画单只桌宠自己的动作（如被踢者播 `kicked`），两只桌宠的配合与位置由 GoodPuppy app 编排。

## 产出

```
run/
  pet_request.json
  imagegen-jobs.json
  prompts/
  decoded/
  frames/frames-manifest.json
  gifs/<name>.gif            # 15 个语义命名透明 GIF
  qa/contact-sheet.png
  qa/review.json
  qa/run-summary.json
```

打包（语义 GIF + 清单）。`<package-dir>` 默认是当前工作目录下的
`output/pets/<pet-name>/`（不再沿用 Codex 的 `~/.codex/pets/`），可用
`--package-dir` 指到任意位置：

```
<package-dir>/
  pet.json                   # 含 15 状态的 name/frames/durations/loop/file 映射
  <name>.gif × 15
```

接入 GoodPuppy 的 `public/state_images/state_NN.gif`（重命名或分配号码）为后续集成任务。

## 技术风险

GIF 透明是 1-bit（硬边）。因保留像素风（硬边、扁平有限调色板），抠色键后量化成带透明索引
的 GIF 边缘干净，几乎无溢色。若未来改用涂鸦风/软边，再考虑切到 `.webp`（平滑 alpha，renderer
改一行）。当前不阻塞。

## 验收标准

- `docs/hatch-puppy-pet/` 存在，`SKILL.md` 描述上述工作流与产物，画风/规则段落与 Hatch Pet 一致。
- `prepare_pet_run.py` 用新 15 状态清单跑通，产出 15 个 row-strip job + base job 与 240×240 布局参考图。
- `compose_gifs.py` / `validate_gifs.py` 能从帧装配并校验 240×240 透明 GIF。
- 全部脚本可被 `python -c` 导入、`--help` 正常（语法/参数校验）。
- 文档（references/*、SKILL.md）无残留 Codex 图集专有描述与 running-left/atlas 残留。
