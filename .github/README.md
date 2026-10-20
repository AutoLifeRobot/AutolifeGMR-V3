# CI runner 运行要求

所有 Linux x64 job 固定使用 `[self-hosted, Linux, X64]`，没有 GitHub-hosted 回退。三个标签必须同时匹配；无合适 runner 时任务排队，不会改用托管 runner。

## 预置环境

- x64 构建/验证基线为 Ubuntu 24.04；这组通用标签本身不保证发行版。裸机 wheel 构建会先检查 `/etc/os-release` 和 `uname -m`，不匹配 Ubuntu 24.04／x86_64 时立即失败；仅测试 job 不增加此限制。runner 管理员需将适配的机器分配给本仓库。
- 预装 Git、Bash；runner 服务用户可写工作目录、`RUNNER_TEMP` 和 Python tool cache，能够访问 GitHub action、工具下载站及依赖仓库。
- wheel 构建需要 C/C++ 编译器；模型检查还需要预装 `git-lfs`，以便 checkout 实体模型文件。
- 旧 autolife wheel job 不再安装/更新全局 Conda，也不删除共享的 `ros2_build` 环境。

## 持久 runner 隔离

非容器 Python job 在 `actions/setup-python` 选定原版本后，通过 `mktemp` 在 `RUNNER_TEMP` 创建独立 venv；`GITHUB_PATH` 只对当前 job 生效。不要把 pip 依赖装进 runner 的全局 Python/Conda，也不要清理其他任务的环境或全局 Docker/cache。临时目录由 Actions runner 的 job 生命周期管理。

本次仅调整调度和必要的环境隔离；触发分支、测试命令、发布条件、产物名称保持原定义。运行在 self-hosted 不等于真机验证；这些 workflow 不启动机器人硬件。
