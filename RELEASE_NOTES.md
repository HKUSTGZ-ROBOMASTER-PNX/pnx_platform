# PnX Platform v0.2.1

修复 DAPLink 切换到 ST-Link 后可能无法采样的问题。切换连接时，工作台现在会等待旧 Rust 适配器进程退出，并串行处理连接、断开与切换项目的请求。旧探针已拔掉且只剩一只 ST-Link 时，只读连接会自动采用当前 ST-Link；调试和烧录仍需明确选择新探针，避免错误设备操作。

本版仍使用平台仓库内的 Rust 后端，不依赖相邻 `cortex-kit` 或 `pnx_template` 源码仓库。Windows 安装包包含 `pnx-dap.exe`。

验证：21 项 Node 测试通过；模拟旧会话采样后切换到真实 ST-Link，自动识别唯一在线探针并收到 57 路变量样本。当前机器没有 DAPLink，尚不能直接复现 DAPLink 固件层面的切换问题。测试未执行烧录或电机控制。

安装包 SHA-256：`3A89032224E24451B47575F1C59F3D431E0A11452DE116AEBBD173CBAF136276`
