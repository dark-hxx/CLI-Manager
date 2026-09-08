// 将构建期配置和资源处理交给 tauri-build；本项目入口不增加额外准备或错误恢复步骤。
fn main() {
    tauri_build::build()
}
