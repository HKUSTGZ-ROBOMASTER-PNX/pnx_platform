# PnX Platform 1.0

PnX Platform 是独立的 Electron 嵌入式开发工作台，集成文件编辑、CMake 构建、探针调试与烧录、实时采样绘图、CSV 记录、图形配置和串口诊断。界面与 Rust 探针后端一同打包，运行时不需要相邻源码仓库，也不会修改用户工程的主程序源码。

## 安装与打开工程

Windows 用户运行 `PnX-Platform-Setup-windows-x64.exe` 选择安装目录，或解压发布的 ZIP，然后启动 `PnX-Platform.exe`。安装包是单文件；安装后的 EXE 需要与同目录的 Electron 运行文件一起保留。首次启动可以不打开工程，模拟采样和串口诊断可直接使用。点击“打开文件夹”选择源码目录后，平台从该目录读取文件、CMake preset、PnX 配置和 ELF。

普通嵌入式工程会从 `CMakeLists.txt` / `.cmake` 的可执行目标、引用的 `.ld` 和现有 ELF 自动识别目标，也可在“目标与插件”中手动设置芯片和 ELF，使用变量采集、断点调试与烧录，无需符合 PnX 目录结构。构建可选 CMake preset 或自定义可执行程序及参数；关闭“调试与烧录前构建”可直接使用已有 ELF。PnX Framework 是按工程启用的内置插件，提供板卡配置与架构诊断。平台按 PnX 的 `configs/boards/<board>/params.json` 与 `robot.json` 结构提供图形配置；板卡资源描述和 Schema 随平台打包，不运行工程内的配置导出脚本。

### Linux 与 macOS

- Linux x64：解压 `PnX-Platform-linux-x64.tar.gz`，进入目录运行 `./"PnX Platform"`。构建基线为 Ubuntu 22.04，需桌面环境与 GTK3、NSS、ALSA、GBM 系统库。
- macOS：按 CPU 选择 `PnX-Platform-macOS-arm64.dmg`（Apple Silicon）或 `PnX-Platform-macOS-x64.dmg`（Intel），打开后将应用拖到 Applications。当前为本地临时签名，尚无 Apple Developer ID 签名和公证；系统可能要求在“隐私与安全性”中确认打开。
- 每个包都内置对应系统和架构的 Rust 后端，运行无需其它工程、Node.js 或 Rust。固件编译仍需本机的 CMake、Ninja 和 Arm 工具链。macOS 桌面启动支持 Homebrew 默认路径。
- Linux 普通桌面用户连接探针前，可在解压目录执行以下操作，然后拔插探针。规则仅覆盖 ST-Link 与产品名称含 CMSIS-DAP 的设备；其它探针参考 [probe-rs 权限配置](https://probe.rs/docs/getting-started/probe-setup/)。串口还需拥有对应设备的访问权限。

```sh
sudo install -m 644 70-pnx-probes.rules /etc/udev/rules.d/70-pnx-probes.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Linux/macOS 的真实硬件烧录、调试和采样性能尚待各平台实板验证，CI 使用模拟后端验证应用运行。

## 主要功能

- 编辑器支持多文件标签、C/C++、Python 轻量高亮和 Markdown 预览、文件和行号跳转、定义查找、断点，以及底部多标签输出面板。
- 构建使用当前打开工程的 CMake preset，最多并行 8 路。产物保存在该工程的 `build/<preset>/`（如 `build/Debug`、`build/Release`），重复构建直接复用；检测到迁移后的缓存路径不匹配时使用 CMake `--fresh` 重新配置。
- 支持 ST-Link 和 DAPLink / CMSIS-DAP。探针连接、调试和烧录使用平台自带的 Rust 后端。真实目标的变量目录需要与固件匹配、包含 DWARF 信息的 ELF。
- “探针与烧录”中的“检查 ST-Link 驱动”可读取 Windows 已接入设备的错误码、驱动版本及 INF，提供 ST 官方下载入口。未接入或查询失败时无法判断驱动是否已安装；设备状态正常也不代表 SWD 连接正常。
- 添加变量后自动采集并更新监看表，默认不绘图；仅明确分配到曲线的变量参与绘制，也可通过刷新图标读取快照。写入开放给源码中能确认显式初始化的可写全局标量，以及显式初始化全局结构体中的直接标量成员（含嵌套成员和数组元素），写入前校验声明文件未改变。支持 `Config config{...}`、`Config config = {...}`、`Config config{}`；仅有成员默认值而对象声明无显式初始化、条件编译、宏声明、指针、常量及无法确定的类型保持只读；源码晚于 ELF 时需重新编译并连接。
- 命中断点或单步暂停时，编辑器显示当前 PC、源码行和黄色执行箭头；调试工具栏提供暂停、继续和单步按钮。调试区可批量读取 `can_diag_bus` 总线状态，或查看带类型的全局状态字段，并对当前 PnX 的 `types::status` 数值给出名称。局部函数返回值尚未纳入快照；无法匹配工程源码时仍显示 PC。
- 实时曲线支持搜索添加全局变量、多 Plot 排布、缩放、暂停、拖动回看、PNG 导出和 CSV 连续记录。超过 256 路变量时自动轮换采集，单路刷新率会随组数下降。图表最多以 30 FPS 绘制，界面显示实际采样速率。
- 图形配置支持应用参数、Robot 电机、资源绑定和硬件概览；保存前检查磁盘版本，最终配置仍以 CMake 校验为准。
- USART 请求/响应诊断由内置 Rust 后端执行，不需要 Python 或工程中的诊断脚本；需要串口适配器和匹配的板端固件。CAN 诊断变量可从 ELF 变量目录中搜索添加。

固件编译需要系统安装 CMake 3.24+、Ninja 和 Arm GNU Toolchain。可在“设置与构建 → 设备工具 → 配置与构建”检测本机工具并配置路径。运行工作台、模拟采样和串口诊断不需要这些编译工具。

## 弹丸荧光检测（预览版）

顶部“弹丸检测”可在未打开工程时使用。点击“示例图片”验证界面，或打开本地图片、视频。视频编码支持取决于浏览器 / Electron，不能解码时会提示转换格式。

“摄像头与图传连接”提供两条输入路径：

- **USB / 手机摄像头 / HDMI 采集卡**：刷新设备并授权后选择具体视频输入，再点击“USB 摄像头”。请求分辨率与帧率是期望值，界面显示实际采集规格；规格不支持时只降低格式要求，不切换到其他设备。手机须先提供 UVC 或厂商虚拟摄像头，单纯 USB 文件传输不提供视频。设备变化会刷新列表，原选择离线时保留提示。
- **DJI 专用 USB 图传（实验，Windows x64）**：填写已有 BulletFluor 文件夹，要求包含 `RC150.dll`、`avcodec-61.dll`、`avformat-61.dll`、`avutil-59.dll`、`swscale-8.dll` 及其依赖。驱动须由用户预先安装。默认加载系统 `libusb0.dll`；如果出现错误 193（位数不匹配），指定厂商提供的 **x64** `libusb0.dll` 绝对路径。点击“扫描图传”，选择设备，再“连接图传”。当前只接受 VID/PID `2CA3:1020`、配置 1、接口 0、Bulk IN `0x81`；自动识别同型号 MI_02 协议串口，按原软件协议请求 / 取消视频关键帧。一次只连接一个 DJI 接收端，且只存在一个对应协议串口时才启用。连接前退出占用接收端的 BulletFluor / ReceiveEnd。

图传桥接使用系统 Windows PowerShell / .NET 编译仓库中的 C# 接收助手，在独立进程加载本地 DLL，通过随机命名管道传输 RGB 帧；不复制厂商二进制到发布包，不自动安装或替换驱动，也不发送曝光、遥控或固件命令。桥接按约 5 FPS 读取解码器的最新缓冲，是尽力预览，不提供原始视频帧序号或严格同步保证。原生解码器初始化出错、USB 断流或帧格式异常会报告错误；关闭输入 / 离开页面释放设备，客户端消失后由 10 秒租约回收。原库内部图像缓冲的并发一致性仍受厂商实现约束。

开发预览可用 `PNX_BULLET_SDK_DIR` 和 `PNX_BULLET_USB_DLL` 提供本机默认路径；界面也会保存用户输入的路径。相机曝光控制和外部指示灯尚未接入。普通摄像头数据留在本机页面，图传数据仅经本机 HTTP 服务传输。

2026-09-30 实机验证：DJI USB 接收端已连续输出 1920×1080 非空变化画面，页面完成检测，关闭后再次连接成功。USB 手机摄像头路径已完成模拟媒体设备测试，仍需使用具体手机的系统摄像头模式实测。

检测在独立 Web Worker 中执行：高斯模糊、HSV 分割、3×3 腐蚀 / 膨胀、8 邻域连通区域过滤。可导入 BulletFluor 的 `config.txt`，导出 JSON 参数、当前结果和逐帧 CSV。H 使用 0–179，亮度使用原图区域内灰度均值 0–255；左右以区域质心划分，区域均值等权聚合。最小面积按处理图像的区域像素数计算，区别于轮廓几何面积。

本原型统计**当前帧区域数**，未实现原软件累计去重或其判定算法；“最少目标数”仅用于单帧参考判定。图像按比例限制到 1920×1080，视频尽力每秒检测 5 帧，不补算遗漏帧。记录最多 10,000 行，暂停 / 跳转 / 更换输入 / 应用参数会停止记录；先导出或清空旧记录再开始新一轮。离开页面暂停视频并释放摄像头。CSV 含实际媒体时间、分辨率、参数和来源，不提供累计弹丸数量或检测精度保证。

验证算法与输入契约：`node --test test/bullet*.test.mjs`。界面测试：`node scripts/bullet-ui-smoke.mjs`（需 Playwright 与 Chrome；可通过 `PNX_PLAYWRIGHT_PATH` 指定 Playwright 的入口，`PNX_BULLET_VIDEO` 指定测试录像）。自动化使用合成 MediaStream 和模拟接收端验证选择、取消、帧解析与释放，不代表真实手机或 DJI 图传出图已验证。真实弹丸检测精度和设备端到端兼容性仍需实测。

## 安全边界

当前版本没有电机参数辨识、运动命令或急停功能。断开探针不等于电机停机。烧录前平台会要求确认；板卡启用 `motor_demo` 时会再次确认。ST-Link 只读采样已在当前板卡验证；烧录、调试控制和串口诊断仍需按目标固件验证。

## 从源码构建

Windows 打包需要 Node.js、Rust 与本机缓存的 Electron 38.8.6。执行：

```powershell
npm run package:win
npm run package:release:win
```

第二条命令生成单文件安装包和 ZIP。macOS/Linux 可运行 `npm install` 和 `npm run package:electron:host`；对应系统需安装 Rust、Node.js 和平台编译依赖，硬件连接尚未在本机验证。源码开发可先构建 `native/` 中的 `pnx-dap`，再运行 `npm start`，通过终端给出的本地地址访问工作台。

## 验证

`npm test` 运行 Node 回归测试；`cargo test --manifest-path native/Cargo.toml --workspace` 运行 Rust 测试。打包后可运行：

```powershell
node scripts/electron-standalone-smoke.mjs <PnX-Platform.exe 路径> <空数据目录>
node scripts/electron-ui-smoke.mjs <PnX-Platform.exe 路径>
```

前者验证空工作区启动、文件夹选择入口和内置模拟后端；后者验证编辑器、配置和曲线交互。硬件压力测试脚本为 `scripts/stlink-stress.mjs`，只读采样，不执行烧录或电机控制。

## GitHub Actions 发布

`.github/workflows/release.yml` 在推送 `vMAJOR.MINOR.PATCH` 标签时构建 Windows x64 安装 EXE/ZIP、Linux x64 tar.gz、macOS Intel/Apple Silicon DMG 及校验清单。四个平台全部通过测试后创建 GitHub Release。构建仅使用本仓库，所需 Rust、MinGW 和 Electron 由 runner 安装；Electron 下载校验 SHA256。

首次启用时，先提交并推送 workflow 到默认分支。在 Actions → Build and publish release → Run workflow 中输入已有标签（如 `v1.0.0`）即可补发；构建会检出该标签的代码，并从标签统一写入 package.json、Rust workspace 与内部包的 Cargo.lock 版本；工作流不回写提交。新发布先运行 `node scripts/release-version.mjs v1.1.3`（换成目标版本），提交后创建并推送同名标签。不要重复使用已有失败标签；旧标签保留原始代码及工作流，直接重跑无法获取后续修复。重跑已有 Release 会更新同名附件。发布 job 使用仓库自带的 `GITHUB_TOKEN`，无需个人 token；仓库需允许 GitHub Actions 运行。


## 插件与重构边界

v1.0.0 使用编译时插件注册表 `src/plugins/registry.mjs`。插件导出 `manifest`（唯一 id、名称、API 版本、能力）、`detect(root)` 与可选的 `resolveProjectTarget(root, preset, buildDirectory)`。新增工程适配器后在注册表加入模块，重新打包即可随应用分发，并在“目标与插件”中按工程启停。探针连接、采集与调试生命周期始终由核心管理。

PnX 后端模块和 Schema 位于 `src/plugins/pnx/`，配置页面及诊断视图位于 `web/plugins/pnx/`，旧顶层副本已移除。项目设置保存在应用数据目录的 projects 缓存中，不向固件工程注入源码。关闭 PnX 插件后其配置 API 不可操作，但通用目标、采样和调试仍可使用。

这一版支持随平台编译的工程适配插件；尚未提供任意第三方插件包的运行时安装、隔离进程 SDK 或 MCU 实验固件插件。既有 ELF 调试仍要求后端支持芯片，并且 ELF 与目标程序匹配；普通工程已使用 wbr_2026 与 Horco CMSIS-DAP 做 12 路、5 秒只读采集验证（约 978 S/s，0 丢帧）；其它目标及调试控制仍需分别验证。

自动识别不读取 launch.json 或 .ioc。静态解析 CMake 的简单变量、可执行目标和链接脚本引用，按目标名筛选有效 ELF；唯一候选自动选取，多个候选通过“重新识别”后的下拉框选择。芯片信息不足或冲突时保留手动输入，不根据 RAM/FLASH 容量猜型号。复杂 CMake 表达式不保证解析；识别也不能保证所选 ELF 已烧录到板上。

### 变量查看配置

曲线页的“保存配置”将当前查看方案写入工程根目录 `pnx-watch.json`（`format: "pnx-watch"`、`version: 1`）。保存变量完整名称、仅监看/曲线分配、曲线组与顺序、排列、各曲线时间窗和请求采样率，不保存地址、变量写入权限或采样数据。

断开连接保留查看列表与布局；重新连接按新 ELF 的完整变量名匹配并恢复采集。未找到或重名的变量保留为待匹配项，不提交采样。打开工程自动加载该文件，也可点击“加载”重新读取；点击“保存配置”更新文件。CSV 数据记录仍独立保存。
