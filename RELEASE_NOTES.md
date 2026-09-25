# PnX Platform v0.2.0

本版将探针连接、调试和高频采样所用的 Rust 后端合并到平台仓库。Windows 安装包由 `native/` 源码编译并包含 `pnx-dap.exe`，启动和打包均不再查找相邻的 `cortex-kit` 或 `pnx_template` 仓库。应用启动后可直接打开任意文件夹；PnX 图形配置读取所选项目的 `configs/boards/<board>/params.json`、`robot.json`，使用平台内置的 Schema 和 H723/F407 板卡资源描述，可读取项目内的 `boards/<board>/board.json`。配置页不再执行项目中的导出脚本。

采样协议与核心读数逻辑保持原实现。连接中的 ST-Link 只读对照：相同 ELF、同一组 256 路 RAM 变量、1000 S/s 请求、8 秒测量，原后端为 49.0 S/s，新后端为 49.1 S/s；两者均收齐 256 路、丢帧 0。模拟采样 UI 测试的总体读取约 1020 S/s、丢帧 0。实际速率仍受探针、地址与板端负载影响。

验证：19 项 Node 测试通过；Windows x64 Electron 独立包通过配置、编辑、构建按钮、调试按钮、曲线、记录与模拟采样 UI 测试。ST-Link 未执行烧录或电机控制。固件编译仍需 CMake、Ninja 和 Arm GNU Toolchain；从源码打包还需 Rust 工具链。

安装包 SHA-256：`E850AC239DB79CC291851F3920DB1E158B196032AF7585B0CDA70E62BB994DAE`
