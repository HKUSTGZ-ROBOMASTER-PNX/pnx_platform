# PnX Platform v0.1.0

Windows x64 桌面工作台。下载 `PnX-Platform-Setup-windows-x64.exe` 并选择安装目录；ZIP 是免安装备用包。安装后的程序可打开任意文件夹编辑 C/C++ 文件，PnX 项目可配置、编译、通过 ST-Link 或 DAPLink 调试与烧录。

本版提供源码断点（点击行号或 F9）、多 Plot 实时采集、暂停与回看、PNG/CSV 导出、图形板卡配置及工具链检测。断点需要带 DWARF 信息的 ELF 和可用的硬件断点槽。安装包内含 Cortex Kit DAP 后端；固件编译仍需要本机 CMake、Ninja 和 Arm GNU Toolchain。

验证：19 项 Node 测试通过；Windows 打包程序通过模拟采样 UI 测试；安装程序可解压完整的 46 个运行文件。真实目标板的断点命中尚未在本次发布中验证。

安装包 SHA-256：`899ECDEDC80B59E41F6A56DB50558BA94B24E6985971AF82A2650FAB54C56395`
