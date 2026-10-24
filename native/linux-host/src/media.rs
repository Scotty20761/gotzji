use std::collections::BTreeMap;

pub(crate) fn audio_status(pipewire: bool, pulse: bool) -> String {
    if pipewire || pulse {
        return r#"{"available":true,"ready":false,"backend":"gstreamer-pulse","supportedActions":["status","record","play","stop"],"reason":"provider_unavailable","readinessReason":"provider_unavailable"}"#.to_string();
    }
    r#"{"available":false,"ready":false,"backend":"pipewire-pulse","supportedActions":["status"],"reason":"dependency_missing","readinessReason":"dependency_missing"}"#.to_string()
}

pub(crate) fn screen_record_status(wayland: bool, portal_hint: bool, x11: bool) -> String {
    if wayland {
        let reason = if portal_hint {
            "portal_session_required"
        } else {
            "dependency_missing"
        };
        return format!(
            r#"{{"available":true,"ready":false,"backend":"pipewire-screen-record","supportedActions":["status"],"reason":"{}","readinessReason":"{}","permissionState":"permission_required"}}"#,
            reason, reason
        );
    }
    if x11 {
        return r#"{"available":true,"ready":false,"backend":"gstreamer-x11","supportedActions":["status","start","stop"],"reason":"provider_unavailable","readinessReason":"provider_unavailable"}"#.to_string();
    }
    r#"{"available":false,"ready":false,"backend":"pipewire-screen-record","supportedActions":["status"],"reason":"dependency_missing","readinessReason":"dependency_missing"}"#.to_string()
}

pub(crate) fn audio_execute(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    super::desktop_session::execute("audio", action, input)
}

pub(crate) fn screen_record_execute(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    super::desktop_session::execute("screen_record", action, input)
}

#[cfg(test)]
fn wayland_session_for(session_type: Option<&str>, wayland_display: bool) -> bool {
    match session_type {
        Some(value) if value.eq_ignore_ascii_case("x11") => false,
        Some(value) if value.eq_ignore_ascii_case("wayland") => true,
        _ => wayland_display,
    }
}

#[cfg(test)]
mod tests {
    use super::{audio_status, screen_record_status, wayland_session_for};

    #[test]
    fn media_dependencies_never_imply_ready_recording() {
        assert!(audio_status(true, false).contains(r#""ready":false"#));
        assert!(screen_record_status(true, true, false).contains("permissionState"));
    }

    #[test]
    fn explicit_x11_session_wins_over_inherited_wayland_socket() {
        assert!(!wayland_session_for(Some("x11"), true));
        assert!(wayland_session_for(Some("wayland"), false));
    }
}
