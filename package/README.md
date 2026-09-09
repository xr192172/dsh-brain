# DSH 猫MEME桌宠插件 - 静态插件版本

一个可爱的猫MEME桌宠，在DSH Web界面右下角根据Agent工作状态做出不同动作。

## 功能特性

- ✨ 在Web界面右下角显示可爱的猫MEME宠物
- 🔄 根据Agent工作状态（idle/running）自动切换动画
- 🎉 任务完成时播放庆祝音效和动画
- 🐱 点击宠物有互动反馈
- 💬 显示状态气泡（休息中/工作中/喵！）
- 🎨 精美的CSS动画效果

## 文件结构

```
catpet-plugin/
├── package.json          # 插件配置文件
├── README.md            # 本文档
└── src/
    ├── index.js         # Host端代码
    └── client.js        # Client端代码
```

## 安装方法

### 方法1：本地安装（推荐）

1. **将插件目录复制到DSH项目**

```bash
# 假设你的DSH项目在 ~/dsh-project
cp -r catpet-plugin ~/dsh-project/node_modules/@dsh/
```

2. **在cordis.yml中添加插件配置**

```yaml
plugins:
  # Host端插件
  @dsh/catpet-desktop-pet: {}

  # Client端插件（在web composition中添加）
```

3. **在web composition中添加Client端**

在DSH的web composition配置中添加：
```yaml
plugins:
  @dsh/catpet-desktop-pet/client: {}
```

### 方法2：链接到项目

如果你在开发插件，可以使用npm link：

```bash
# 在插件目录
cd catpet-plugin
npm link

# 在DSH项目目录
cd ~/dsh-project
npm link @dsh/catpet-desktop-pet
```

### 方法3：发布到npm（推荐用于分享）

```bash
# 在插件目录
cd catpet-plugin
npm publish
```

然后在DSH项目中安装：
```bash
npm install @dsh/catpet-desktop-pet
```

## 使用说明

安装完成后，重启DSH，猫宠物就会自动出现在右下角。

### 状态说明

| 状态 | 动画 | 气泡文字 | 说明 |
|------|------|----------|------|
| idle | 轻轻上下弹跳 | "喵~ 在休息中" | Agent空闲时 |
| running | 左右摇摆 | "工作中..." | Agent正在处理任务 |
| celebrate | 放大旋转 | "任务完成！" | 任务完成时（需手动触发） |

### 交互功能

- **点击宠物**：显示"喵！"气泡
- **悬停效果**：宠物会放大

## 自定义选项

### 更换猫的图片

编辑 `src/client.js`，修改 `catImages` 对象：

```javascript
const catImages = {
  idle: 'https://your-image-url-1.jpg',
  running: 'https://your-image-url-2.jpg',
  celebrate: 'https://your-image-url-3.jpg'
}
```

### 更换音效

编辑 `src/client.js`，修改 `completeSound`：

```javascript
const completeSound = 'https://your-audio-url.mp3'
```

### 调整动画速度

编辑 `src/client.js` 中的CSS动画定义：

```css
@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); }
}
/* 修改 animation-duration 来调整速度 */
.cat-pet-image {
  animation: bounce 2s infinite ease-in-out; /* 改为1s更快，3s更慢 */
}
```

### 调整宠物大小

编辑 `src/client.js` 中的CSS：

```css
.cat-pet-image {
  width: 120px;  /* 改为你想要的大小 */
  height: 120px;
}
```

### 调整位置

编辑 `src/client.js` 中的CSS：

```css
.cat-pet-overlay {
  bottom: 20px;   /* 距离底部距离 */
  right: 20px;    /* 距离右侧距离 */
}
```

## 技术细节

### Host端（src/index.js）

- 监听 `agent/status` 事件跟踪Agent状态
- 监听 `agent/turn-stopping` 事件检测任务完成
- 通过 `harness.handle()` 注册RPC方法供Client调用：
  - `queryPetStatus`: 查询当前状态
  - `updatePetStatus`: 获取状态更新
  - `petTaskComplete`: 标记任务完成

### Client端（src/client.js）

- 使用React创建UI组件
- 在 `shell.overlay` Slot中注册宠物UI
- 通过 `host.call()` 与Host端通信
- 使用CSS动画实现各种效果
- 使用Web Audio API播放音效

### 依赖关系

- `cordis`: Cordis框架核心（peerDependency）
- React: Client端自动可用
- 无其他运行时依赖

## 资源说明

当前使用的资源：

**图片来源**：ImgFlip（公共MEME图片）
- 闲置状态：https://i.imgflip.com/2/345v97.jpg
- 工作状态：https://i.imgflip.com/2/34bly.jpg
- 庆祝状态：https://i.imgflip.com/2/34ha6.jpg

**音效来源**：MyInstants（公共音效）
- 完成音效：https://www.myinstants.com/media/sounds/mario-coin-sound.mp3

### 使用本地资源

如果你想使用本地资源：

1. 创建 `assets/` 目录
2. 将图片和音频文件放入
3. 修改代码中的URL引用

```javascript
// 本地资源示例
const catImages = {
  idle: './assets/idle.jpg',
  running: './assets/running.jpg',
  celebrate: './assets/celebrate.jpg'
}
const completeSound = './assets/complete.mp3'
```

## 故障排除

### 宠物不显示

1. 检查插件是否正确加载
2. 查看浏览器控制台是否有错误
3. 确认 `shell.overlay` Slot是否可用
4. 检查CSS是否正确加载

### 动画不工作

1. 检查浏览器控制台是否有CSS错误
2. 确认React组件是否正确渲染
3. 检查状态更新是否触发

### 音效不播放

1. 浏览器可能阻止自动播放，需要用户先与页面交互
2. 检查音频URL是否可访问
3. 确认音频格式被浏览器支持（建议使用MP3）
4. 检查浏览器自动播放策略

### 状态不更新

1. 检查Host端是否正确监听事件
2. 确认RPC调用是否成功
3. 查看Host端日志输出

## 开发和调试

### 启用详细日志

编辑 `src/index.js` 和 `src/client.js`，添加更多console.log：

```javascript
console.log('Cat Pet: Status changed to', currentStatus)
console.log('Cat Pet: Component mounted')
```

### 调试RPC通信

在Client端添加错误处理：

```javascript
try {
  const result = await host.call('queryPetStatus')
  console.log('RPC result:', result)
} catch (e) {
  console.error('RPC error:', e)
}
```

### 查看React组件状态

在组件中添加调试输出：

```javascript
console.log('Current state:', { status, celebrate, bubble })
```

## 性能优化

当前实现已经包含以下优化：

- ✅ 使用React.memo避免不必要的重渲染
- ✅ 定时器清理避免内存泄漏
- ✅ 使用mounted标志防止已卸载组件更新状态
- ✅ 使用requestAnimationFrame优化动画性能

如果需要进一步优化：

1. 使用图片懒加载
2. 压缩音频文件
3. 减少状态轮询频率
4. 使用Web Worker处理音频

## 许可证

MIT License - 自由使用、修改和分发

## 贡献

欢迎提交Issue和Pull Request！

## 致谢

- **DSH团队** - 提供了优秀的Cordis框架
- **ImgFlip** - 提供可爱的MEME图片
- **MyInstants** - 提供音效资源

## 更新日志

### v1.0.0 (2025-01-19)
- ✨ 初始发布
- ✨ 支持Agent状态跟踪
- ✨ 支持任务完成音效
- ✨ 支持点击互动
- 📝 完整文档

## 联系方式

如有问题或建议，请提交Issue或Pull Request。

---

**享受你的猫MEME桌宠吧！** 🐱✨