const ACTIONS: &[&str] = &[
    "status",
    "type_text",
    "press_key",
    "hotkey",
    "mouse_move",
    "click",
    "double_click",
    "right_click",
    "scroll",
    "drag",
    "release_all",
    "key_down",
    "key_up",
    "button_down",
    "button_up",
];

pub(crate) fn status_json(wayland: bool, portal_hint: bool) -> String {
    if !wayland {
        return r#"{"available":false,"ready":false,"backend":"remote-desktop-portal","reason":"unsupported_platform","readinessReason":"unsupported_platform","supportedActions":["status"]}"#.to_string();
    }
    let reason = if portal_hint {
        "portal_session_required"
    } else {
        "dependency_missing"
    };
    let actions = ACTIONS
        .iter()
        .map(|action| format!(r#""{}""#, action))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"available":true,"ready":false,"backend":"remote-desktop-portal","supportedActions":[{}],"reason":"{}","readinessReason":"{}","permissionState":"permission_required"}}"#,
        actions, reason, reason
    )
}

pub(crate) fn execute(
    action: &str,
    input: &std::collections::BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    super::desktop_session::execute("input_event", action, input)
}

#[cfg(test)]
mod tests {
    use super::status_json;

    #[test]
    fn wayland_portal_never_claims_unattended_readiness() {
        let value = status_json(true, true);
        assert!(value.contains(r#""ready":false"#));
        assert!(value.contains("permission_required"));
    }
}
