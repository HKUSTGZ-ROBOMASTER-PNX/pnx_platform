# PnX Platform

PnX Platform 是独立的 Electron 嵌入式开发工作台，集成文件编辑、CMake 构建、探针调试与烧录、实时采样绘图、CSV 记录、图形配置和串口诊断。界面与 Rust 探针后端一同打包，运行时不需要相邻源码仓库，也不会修改用户工程的主程序源码。

## 安装与打开工程

Windows 用户运行 `PnX-Platform-Setup-windows-x64.exe` 选择安装目录，或解压发布的 ZIP，然后启动 `PnX-Platform.exe`。安装包是单文件；安装后的 EXE 需要与同目录的 Electron 运行文件一起保留。首次启动可以不打开工程，模拟采样和串口诊断可直接使用。点击“打开文件夹”选择源码目录后，平台从该目录读取文件、CMake preset、PnX 配置和 ELF。

普通 CMake 工程可编辑和构建。PnX 工程还可使用板卡配置、变量目录、探针调试和烧录。平台按 PnX 的 `configs/boards/<board>/params.json` 与 `robot.json` 结构提供图形配置；板卡资源描述和 Schema 随平台打包，不运行工程内的配置导出脚本。

## 主要功能

- 编辑器支持多文件标签、C/C++ 轻量高亮、文件和行号跳转、定义查找、断点，以及底部多标签输出面板。
- 构建使用当前打开工程的 CMake preset，最多并行 8 路。产物保存在该工程的 `build/pnx-platform/`；移动工程后会使用新的构建目录。
- 支持 ST-Link 和 DAPLink / CMSIS-DAP。探针连接、调试和烧录使用平台自带的 Rust 后端。真实目标的变量目录需要与固件匹配、包含 DWARF 信息的 ELF。
- “探针与烧录”中的“检查 ST-Link 驱动”可读取 Windows 已接入设备的错误码、驱动版本及 INF，提供 ST 官方下载入口。未接入或查询失败时无法判断驱动是否已安装；设备状态正常也不代表 SWD 连接正常。
- 变量可选择“仅查看 / 修改”，通过“读取”获得按需快照，无需 Plot 订阅。写入仅开放给源码中能确认显式初始化的可写全局标量，写入前校验声明文件未改变。条件编译、宏声明、结构体成员及无法确定的类型保持只读；源码晚于 ELF 时需重新编译并连接。
- 命中断点或单步暂停时，编辑器显示当前 PC、源码行和黄色执行箭头；调试工具栏提供暂停、继续和单步按钮。调试区可批量读取 `can_diag_bus` 总线状态，或查看带类型的全局状态字段，并对当前 PnX 的 `types::status` 数值给出名称。局部函数返回值尚未纳入快照；无法匹配工程源码时仍显示 PC。
- 实时曲线支持搜索添加全局变量、多 Plot 排布、缩放、暂停、拖动回看、PNG 导出和 CSV 连续记录。超过 256 路变量时自动轮换采集，单路刷新率会随组数下降。图表最多以 30 FPS 绘制，界面显示实际采样速率。
- 图形配置支持应用参数、Robot 电机、资源绑定和硬件概览；保存前检查磁盘版本，最终配置仍以 CMake 校验为准。
- USART 请求/响应诊断由内置 Rust 后端执行，不需要 Python 或工程中的诊断脚本；需要串口适配器和匹配的板端固件。CAN 诊断变量可从 ELF 变量目录中搜索添加。

固件编译需要系统安装 CMake 3.22+、Ninja 和 Arm GNU Toolchain。可在“设置与构建 → 设备工具 → 配置与构建”检测本机工具并配置路径。运行工作台、模拟采样和串口诊断不需要这些编译工具。

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

`.github/workflows/release.yml` 在推送 `vMAJOR.MINOR.PATCH` 标签时构建 Windows x64 安装 EXE、便携 ZIP 与 `SHA256SUMS.txt`，测试通过后创建 GitHub Release。构建仅使用本仓库，所需 Rust、MinGW 和 Electron 由 runner 安装；Electron 下载校验 SHA256。

首次启用时，先提交并推送 workflow 到默认分支。在 Actions → Build and publish release → Run workflow 中输入已有标签（如 `v0.2.12`）即可补发；构建会检出该标签的代码并核对版本。以后新版本提交后推送新标签即可触发。重跑已有 Release 会更新同名附件。发布 job 使用仓库自带的 `GITHUB_TOKEN`，无需个人 token；仓库需允许 GitHub Actions 运行。
