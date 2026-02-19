#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::{Entry, Error as KeyringError};
use serde::Deserialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{image::Image, Manager, WindowEvent};

const KEYRING_SERVICE: &str = "gitlab-action-radar";
const KEYRING_ACCOUNT: &str = "gitlab-pat";
const TRAY_ID: &str = "main-tray";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayIndicatorPayload {
    conflict_count: u32,
    failed_ci_count: u32,
    review_pending_count: u32,
    actionable_total_count: u32,
}

fn set_pixel(rgba: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 4]) {
    let index = ((y * width + x) * 4) as usize;
    rgba[index] = color[0];
    rgba[index + 1] = color[1];
    rgba[index + 2] = color[2];
    rgba[index + 3] = color[3];
}

fn draw_bar(rgba: &mut [u8], width: u32, x_start: u32, count: u32, active_color: [u8; 4], inactive_color: [u8; 4]) {
    let bar_width = 4u32;
    let bottom = 15u32;
    let height = match count {
        0 => 5u32,
        1 => 8u32,
        2 => 11u32,
        _ => 13u32,
    };
    let top = bottom + 1 - height;
    let color = if count > 0 { active_color } else { inactive_color };

    for y in top..=bottom {
        for x in x_start..(x_start + bar_width) {
            // Keep corners transparent for a rounded look.
            let is_corner = (y == top || y == bottom) && (x == x_start || x == (x_start + bar_width - 1));
            if is_corner {
                continue;
            }
            set_pixel(rgba, width, x, y, color);
        }
    }
}

fn create_tray_icon_image(conflict_count: u32, failed_ci_count: u32, review_pending_count: u32) -> Image<'static> {
    let width = 18u32;
    let height = 18u32;
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    let inactive = [148, 163, 184, 220];

    // conflict / CI failed / review pending
    draw_bar(&mut rgba, width, 1, conflict_count, [245, 158, 11, 255], inactive);
    draw_bar(&mut rgba, width, 7, failed_ci_count, [239, 68, 68, 255], inactive);
    draw_bar(&mut rgba, width, 13, review_pending_count, [14, 165, 233, 255], inactive);

    // Avoid an all-transparent icon by adding a subtle baseline.
    for x in 1..17 {
        set_pixel(&mut rgba, width, x, 16, [100, 116, 139, 120]);
    }

    Image::new_owned(rgba, width, height)
}

fn create_tray_tooltip(payload: &TrayIndicatorPayload) -> String {
    if payload.actionable_total_count == 0 {
        return "GitLab Action Radar: 対応が必要なMRはありません".to_string();
    }

    format!(
        "GitLab Action Radar: 合計{}件（競合 {} / CI失敗 {} / レビュー待ち {}）",
        payload.actionable_total_count, payload.conflict_count, payload.failed_ci_count, payload.review_pending_count
    )
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|err| format!("failed to access secure storage: {err}"))
}

#[tauri::command]
fn save_pat(token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("PAT is empty".to_string());
    }

    let entry = keyring_entry()?;
    entry
        .set_password(trimmed)
        .map_err(|err| format!("failed to store PAT: {err}"))
}

#[tauri::command]
fn load_pat() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("failed to load PAT: {err}")),
    }
}

#[tauri::command]
fn clear_pat() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("failed to clear PAT: {err}")),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http/https URLs are supported".to_string());
    }

    open::that_detached(url).map_err(|err| format!("failed to open URL: {err}"))
}

#[tauri::command]
fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return open::that_detached("x-apple.systempreferences:com.apple.preference.notifications")
            .map_err(|err| format!("failed to open notification settings: {err}"));
    }

    #[cfg(target_os = "windows")]
    {
        return open::that_detached("ms-settings:notifications")
            .map_err(|err| format!("failed to open notification settings: {err}"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("this platform does not support opening notification settings automatically".to_string())
    }
}

#[tauri::command]
fn update_tray_indicator(app: tauri::AppHandle, payload: TrayIndicatorPayload) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon not found".to_string())?;

    tray.set_icon(Some(create_tray_icon_image(
        payload.conflict_count,
        payload.failed_ci_count,
        payload.review_pending_count,
    )))
    .map_err(|err| format!("failed to update tray icon: {err}"))?;

    let _ = tray.set_icon_as_template(false);

    let title = if payload.actionable_total_count > 0 {
        Some(if payload.actionable_total_count > 99 {
            "99+".to_string()
        } else {
            payload.actionable_total_count.to_string()
        })
    } else {
        None
    };

    let _ = tray.set_title(title.as_deref());
    let _ = tray.set_tooltip(Some(create_tray_tooltip(&payload)));

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            save_pat,
            load_pat,
            clear_pat,
            open_external_url,
            open_notification_settings,
            update_tray_indicator
        ])
        .setup(|app| {
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_item])?;

            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(create_tray_icon_image(0, 0, 0))
                .icon_as_template(false)
                .tooltip("GitLab Action Radar: 対応が必要なMRはありません")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    if event.id == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                window.on_window_event(|event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
