// Прячем консольное окно в release-сборке под Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fesb_toolkit_lib::run()
}
