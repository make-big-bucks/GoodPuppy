//! 开发模式的真实窗口生命周期检查；使用独立 identifier 运行，不连接已保存账号。
use crate::{
    bubbles::Bubbles,
    commands,
    hit_test::{HitShapes, PetHitShape},
};
use tauri::{AppHandle, Emitter, Listener, Manager};

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let result = run(&app).await;
        let result = result.and_then(|_| {
            let main = app.get_webview_window("main").ok_or("main unavailable")?;
            if crate::diagnostics::get_diagnostic_report(app.clone(), main).is_ok() {
                return Err("diagnostic export role guard missing".into());
            }
            let lounge = app
                .get_webview_window("lounge")
                .ok_or("lounge unavailable")?;
            let report = crate::diagnostics::get_diagnostic_report(app.clone(), lounge)?;
            if !report.contains("app-start") {
                return Err("persistent startup diagnostic missing".into());
            }
            Ok(())
        });
        match &result {
            Ok(()) => eprintln!(
                "[native-smoke] PASS: ready snapshots, hidden-focus guard, stale-close guard, same-label recreation and toast delivery"
            ),
            Err(error) => eprintln!("[native-smoke] FAIL: {error}"),
        }
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
}

async fn run(app: &AppHandle) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("main unavailable")?;
    let invalid = commands::spawn_pet_window(
        app.clone(),
        main.clone(),
        app.state::<HitShapes>(),
        app.state::<Bubbles>(),
        "pet-invalid-geometry".into(),
        Some("invalid-geometry".into()),
        200.0,
        200.0,
        0.0,
        120.0,
    )
    .await;
    if invalid.is_ok() || app.get_webview_window("pet-invalid-geometry").is_some() {
        return Err("invalid geometry created a native window".into());
    }
    for cycle in 0..2 {
        let instance = format!("native-smoke-{cycle}");
        commands::spawn_pet_window(
            app.clone(),
            main.clone(),
            app.state::<HitShapes>(),
            app.state::<Bubbles>(),
            "pet-smoke".into(),
            Some(instance.clone()),
            200.0,
            200.0,
            150.0,
            120.0,
        )
        .await?;
        let pet = app
            .get_webview_window("pet-smoke")
            .ok_or("pet unavailable")?;
        let geometry = commands::get_window_geometry(pet.clone(), Some(instance.clone())).await?;
        let geometry = serde_json::to_value(geometry).map_err(|error| error.to_string())?;
        if geometry["width"].as_f64().unwrap_or(0.0) <= 0.0 {
            return Err("native window geometry snapshot unavailable".into());
        }
        if commands::get_window_geometry(pet, Some("stale-instance".into()))
            .await
            .is_ok()
        {
            return Err("window geometry snapshot stale-instance guard missing".into());
        }
        let area = commands::get_pet_monitor_work_area(
            app.clone(),
            main.clone(),
            "pet-smoke".into(),
            Some(instance.clone()),
        )
        .await?;
        let area = serde_json::to_value(area).map_err(|e| e.to_string())?;
        if area["width"].as_f64().unwrap_or(0.0) <= 0.0 {
            return Err("target monitor work area unavailable".into());
        }
        if commands::get_pet_monitor_work_area(
            app.clone(),
            main.clone(),
            "pet-smoke".into(),
            Some("stale-instance".into()),
        )
        .await
        .is_ok()
        {
            return Err("target monitor stale-instance guard missing".into());
        }
        commands::spawn_bubble_window(
            app.clone(),
            main.clone(),
            app.state::<HitShapes>(),
            app.state::<Bubbles>(),
            "bubble-smoke".into(),
            Some(instance.clone()),
            "pet-smoke".into(),
            false,
            200.0,
            120.0,
            200.0,
            80.0,
        )
        .await?;
        exercise_presenter(
            app,
            "pet-smoke",
            &instance,
            "pet-state",
            serde_json::json!({"petId":"default","skin":"default","status":null}),
        )
        .await?;
        exercise_presenter(
            app,
            "bubble-smoke",
            &instance,
            "pet-history",
            serde_json::json!({"messages":[]}),
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
        if cycle == 1 {
            commands::close_pet_window(
                app.clone(),
                main.clone(),
                "pet-smoke".into(),
                Some("native-smoke-0".into()),
            )
            .await?;
            if app.get_webview_window("pet-smoke").is_none() {
                return Err("stale close destroyed a new instance".into());
            }
        }
        commands::close_bubble_window(
            app.clone(),
            main.clone(),
            "bubble-smoke".into(),
            Some(instance.clone()),
        )
        .await?;
        commands::close_pet_window(
            app.clone(),
            main.clone(),
            "pet-smoke".into(),
            Some(instance.clone()),
        )
        .await?;
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
        None,
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
            if !visible && label == "bubble-self" {
                let bubble = app.get_webview_window(label).ok_or("bubble missing")?;
                let identity =
                    commands::get_managed_window_instance(app.clone(), main.clone(), label.into())?;
                if commands::focus_pet_panel(bubble, identity).await? {
                    return Err("hidden bubble gained focus".into());
                }
            }
            if actual != visible {
                return Err(format!("{label} visibility differs from {visible}"));
            }
        }
    }
    exercise_toast(app).await?;
    Ok(())
}

async fn exercise_presenter(
    app: &AppHandle,
    label: &str,
    instance: &str,
    event: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let label_owned = label.to_string();
    let instance_owned = instance.to_string();
    let app_reply = app.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let listener = app.listen_any("presenter-ready", move |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        if value["label"] == label_owned && value["instanceId"] == instance_owned {
            if value["controllerId"] == "native-probe" {
                let _ = ready_tx.send(());
            } else {
                let _ = app_reply.emit_to(
                    label_owned.as_str(),
                    "presenter-ready-request",
                    serde_json::json!({"instanceId":instance_owned,"controllerId":"native-probe"}),
                );
            }
        }
    });
    app.emit_to(
        label,
        "presenter-ready-request",
        serde_json::json!({"instanceId":instance,"controllerId":"native-probe"}),
    )
    .map_err(|error| error.to_string())?;
    let ready = tauri::async_runtime::spawn_blocking(move || {
        ready_rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|error| error.to_string())?;
    app.unlisten(listener);
    ready.map_err(|error| format!("presenter readiness failed: {error}"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let expected = (label.to_string(), instance.to_string(), event.to_string());
    let listener = app.listen_any("presenter-applied", move |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        if value["label"] == expected.0
            && value["instanceId"] == expected.1
            && value["event"] == expected.2
        {
            let _ = tx.send(());
        }
    });
    app.emit_to(label, event, serde_json::json!({"instanceId":instance,"controllerId":"native-probe","sequence":1,"payload":payload})).map_err(|error| error.to_string())?;
    let applied = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|error| error.to_string())?;
    app.unlisten(listener);
    applied.map_err(|error| format!("presenter snapshot not applied: {error}"))
}

async fn exercise_toast(app: &AppHandle) -> Result<(), String> {
    let lounge = app
        .get_webview_window("lounge")
        .ok_or("lounge unavailable")?;
    let response = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let ready = app.listen_any("toast-ready", move |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else { return; };
        if value["label"] == "toast-smoke" && value["instanceId"] == "toast-smoke-instance" {
            let _ = response.emit_to("toast-smoke", "toast-data", serde_json::json!({"instanceId":"toast-smoke-instance","payload":{
                "roomId":"smoke-room","roomName":"Native check","userId":"smoke-user","displayName":"Probe","petId":"default","skin":"default","autoDismissMs":0
            }}));
        }
    });
    let applied = app.listen_any("toast-applied", move |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        if value["label"] == "toast-smoke" && value["instanceId"] == "toast-smoke-instance" {
            let _ = tx.send(());
        }
    });
    commands::spawn_toast_window(
        app.clone(),
        lounge.clone(),
        "toast-smoke".into(),
        Some("toast-smoke-instance".into()),
        300.0,
        300.0,
        340.0,
        104.0,
    )
    .await?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|error| error.to_string())?;
    app.unlisten(ready);
    app.unlisten(applied);
    result.map_err(|error| format!("toast data delivery failed: {error}"))?;
    commands::close_toast_window(
        app.clone(),
        lounge,
        "toast-smoke".into(),
        Some("toast-smoke-instance".into()),
    )
    .await
}
