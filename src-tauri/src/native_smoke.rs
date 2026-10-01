//! 开发模式的真实窗口生命周期检查；使用独立 identifier 运行，不连接已保存账号。
use crate::{
    bubbles::Bubbles,
    commands,
    hit_test::{HitShapes, PetHitShape},
};
use tauri::{AppHandle, Manager};

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let result = run(&app).await;
        match &result {
            Ok(()) => eprintln!(
                "[native-smoke] PASS: create, hide/show, destroy and same-label recreation"
            ),
            Err(error) => eprintln!("[native-smoke] FAIL: {error}"),
        }
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
}

async fn run(app: &AppHandle) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("main unavailable")?;
    for _ in 0..2 {
        commands::spawn_pet_window(
            app.clone(),
            main.clone(),
            app.state::<HitShapes>(),
            app.state::<Bubbles>(),
            "pet-smoke".into(),
            200.0,
            200.0,
            150.0,
            120.0,
        )
        .await?;
        commands::spawn_bubble_window(
            app.clone(),
            main.clone(),
            app.state::<HitShapes>(),
            app.state::<Bubbles>(),
            "bubble-smoke".into(),
            "pet-smoke".into(),
            false,
            200.0,
            120.0,
            200.0,
            80.0,
        )
        .await?;
        if !app
            .get_webview_window("pet-smoke")
            .ok_or("pet missing")?
            .is_visible()
            .map_err(|error| error.to_string())?
        {
            return Err("spawn returned before showing pet".into());
        }
        {
            let shapes = app.state::<HitShapes>();
            let mut registry = shapes.lock().unwrap();
            registry
                .shapes
                .insert("pet-smoke".into(), PetHitShape::default());
            registry.ignore.insert("pet-smoke".into(), true);
        }
        commands::close_bubble_window(app.clone(), main.clone(), "bubble-smoke".into()).await?;
        commands::close_pet_window(app.clone(), main.clone(), "pet-smoke".into()).await?;
        if app.get_webview_window("pet-smoke").is_some()
            || app.get_webview_window("bubble-smoke").is_some()
        {
            return Err("destroy returned before manager cleanup".into());
        }
        let shapes = app.state::<HitShapes>();
        let registry = shapes.lock().unwrap();
        if registry.shapes.contains_key("pet-smoke") || registry.ignore.contains_key("pet-smoke") {
            return Err("destroy left stale hit/cursor cache".into());
        }
    }
    commands::spawn_bubble_window(
        app.clone(),
        main.clone(),
        app.state::<HitShapes>(),
        app.state::<Bubbles>(),
        "bubble-self".into(),
        "main".into(),
        true,
        200.0,
        120.0,
        200.0,
        80.0,
    )
    .await?;
    for visible in [false, true, false] {
        commands::set_self_visible(app.clone(), main.clone(), visible).await?;
        for label in ["main", "bubble-self"] {
            let actual = app
                .get_webview_window(label)
                .ok_or("self overlay missing")?
                .is_visible()
                .map_err(|error| error.to_string())?;
            if actual != visible {
                return Err(format!("{label} visibility differs from {visible}"));
            }
        }
    }
    Ok(())
}
