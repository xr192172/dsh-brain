# dsh-pet-miyako — miyako 桌宠

DeepSeek Harness Web GUI 的桌面宠物插件（自定义版）。

- **名字**：miyako，紫色 #9977CC 主题
- **动画**：待机 15 帧 / 等待 15 帧 / 工作 12 帧（统一 8fps，乒乓往返播放）+ **点击动画 17 帧**（点击时从头播放一次，10fps）
- **点击音效**：点击桌宠播放音效（assets/whale/click.mp3，可自行替换）
- **状态联动**：发消息 → 等待动画 1.5 秒 → 思考/干活（工作动画）→ 完成跳跃
- **交互**：拖动、自由缩放（滚轮 / 右下角手柄 / 面板 ±）、锁定（禁止移动缩放）、改名、隐藏/召唤
## 安装

需要 DeepSeek Harness `0.1.x`、pnpm 可用。使用本目录下的打包文件：

```sh
dsh plugin --profile web add ./dsh-pet-miyako-1.0.4.tgz
```

安装后**重启 `dsh web`**。

> 注意：如果 pnpm 版本 ≥ 11.21，默认的供应链策略 `minimum-release-age: 24h` 会拦截发布不足 24 小时的包，导致安装失败（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。请在 profile 的 `pnpm-workspace.yaml` 中加入：
>
> ```yaml
> minimumReleaseAge: 0
> ```

## 与 dsh-web-ui 全家桶共存

如果同时安装了 `@linxin666/dsh-web-ui-all`（全家桶），它自带一只鲸鱼娘宠物。为避免出现两只桌宠，需要在 profile 补丁 `cordis.patch.yml` 中禁用原宠物：

```yaml
- id: web-ui-pet
  disabled: true
```

> 全家桶（`dsh-web-ui-all`）内的宠物行 id 为 `web-ui-pet`；若是单独安装的 `@linxin666/dsh-pet`，行 id 为 `pet`。按实际来源选择对应的 id。

## 自定义

素材替换（替换后刷新页面，如不生效请重启）：

```
<profile>/node_modules/dsh-pet-miyako/assets/whale/
├── spritesheet.webp        # 8列x10行图集（点击动画在第10行；每格 384x416，总图 9216x4160）
├── pet.json                # 名字 / 帧数等元数据
├── click.mp3               # 点击音效（替换同名文件即可换音效）
└── online-offline.png      # 下线动画图片（上下线图，替换同名文件即可换图）
```

下线动画会以**桌宠素材的实际可见高度**显示 `online-offline.png`（运行时自动测量图集内素材边界，宽度按图片自身比例缩放、不变形），并定位在桌宠原位置，快速闪烁几下后消失；上线时桌宠**渐显**出现。

动画节奏在 `lib/client.js` 的 `TRACKS` 表中调整（毫秒/帧）。

## 版本记录

- **1.0.4**：修复下线图片尺寸——改为按桌宠素材实际可见高度缩放（图集素材仅占精灵框 51.7% 高，旧版按整框高度渲染导致偏大），并自动对齐位置与比例。
- **1.0.3**：新增上线渐显动画与下线闪烁动画（`online-offline.png`，高度与桌宠一致、保持原比例）。
- **1.0.2**：默认宠物名改为 **miyako**（含加载/报错/设置文案）；"隐藏/召唤"改为"下线/上线"（含设置项与英文文案）。
- **1.0.1**：修复客户端注册 ID（`dsh-pet-miyako`），修复与全家桶宠物同装时的样式标签冲突；完善共存说明与 pnpm 11.21 策略排障。
- **1.0.0**：初版（miyako 紫色主题桌宠）。

## 卸载

```sh
dsh plugin --profile web remove dsh-pet-miyako
```

