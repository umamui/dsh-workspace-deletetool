# dsh-workspace-deletetool

给 DeepSeek Harness 补上「删除工作区」：删掉工作区登记，并且可以选择连磁盘目录一起删。

## 为什么需要

DSH 自带的删除只删登记，保留目录和所有成员会话。想彻底清掉一个工作区还得自己打开文件管理器删目录。这个插件把两步合成一个接口，方便脚本或外部工具调用。

## 接口

三条同源路由（只接受本机来源：`127.0.0.1` / `localhost` / `::1`），没有额外鉴权：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /dsh-workspace-deletetool/catalog` | 列出所有工作区，带每个目录的大小与文件数（统计上限 2 万个文件） |
| `POST /dsh-workspace-deletetool/delete` | `{ workspaceId, deleteDirectory? }`，删除登记；`deleteDirectory` 为真时连目录一起删 |
| `POST /dsh-workspace-deletetool/rename` | 重命名工作区 |

请求体上限 8 KB。

## 护栏

任何一条命中即拒绝，不做删除：

- 只允许删除已登记的工作区路径；
- 盘符根、层级过浅的目录、用户主目录、DSH 数据目录、`AppData`、桌面、文档、下载，以及这些目录的上级目录；
- 删除前再校验一次绝对路径归属，避免被相对路径或链接绕过。

## 删除策略

Windows 上被进程占用的文件既不能删也不能改名，一次性删除会整体失败。所以删除降级为「自底向上逐个删」：能删的删，删不掉的项连同原因一起收进返回结果，绝不谎报成功。

## 安装

```
plugin_manager install_bundle target=file:<本包目录>
```
