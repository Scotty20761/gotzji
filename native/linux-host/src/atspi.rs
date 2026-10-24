use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const ACTIONS: &[&str] = &[
    "status",
    "list_windows",
    "observe",
    "observe_summary",
    "inspect_elements",
    "find_element",
    "click",
    "focus",
];
const AT_SPI_DESTINATION: &str = "org.a11y.atspi.Registry";
const AT_SPI_ROOT: &str = "/org/a11y/atspi/accessible/root";
const AT_SPI_INTERFACE: &str = "org.a11y.atspi.Accessible";
const MAX_ADDRESS_BYTES: usize = 4 * 1024;
const MAX_OBJECT_PATH_BYTES: usize = 512;
const MAX_ITEMS: usize = 256;
const MAX_DEPTH: usize = 8;
const MAX_COMMAND_OUTPUT_BYTES: usize = 512 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_millis(1_500);

pub(crate) fn status_json() -> String {
    let dbus = env_present("DBUS_SESSION_BUS_ADDRESS");
    let atspi = env_present("AT_SPI_BUS_ADDRESS");
    if !dbus && !atspi {
        return status(false, false, Some("dependency_missing"), "atspi2");
    }
    if !executable_in_path("gdbus") {
        return status(true, false, Some("dependency_missing"), "atspi2");
    }
    match query_children(AT_SPI_ROOT) {
        Ok(_) => status(true, true, None, "atspi2-gdbus"),
        Err(_) => status(true, false, Some("provider_unavailable"), "atspi2-gdbus"),
    }
}

/// Deterministic status helper used by the profile matrix. Bus presence alone
/// is not a readiness proof; the runtime status path performs a bounded
/// semantic `GetChildren` probe before advertising the provider as ready.
#[cfg(test)]
pub(crate) fn status_json_for(dbus: bool, atspi: bool) -> String {
    if !dbus || !atspi {
        return status(false, false, Some("dependency_missing"), "atspi2");
    }
    status(true, false, Some("provider_probe_required"), "atspi2")
}

pub(crate) fn execute(
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, (&'static str, &'static str, bool)> {
    if action == "status" {
        return Ok(status_json());
    }
    if !ACTIONS.contains(&action) {
        return Err((
            "UNSUPPORTED_PLATFORM",
            "This AT-SPI operation is not supported by the native host",
            true,
        ));
    }
    if !env_present("DBUS_SESSION_BUS_ADDRESS") && !env_present("AT_SPI_BUS_ADDRESS") {
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "AT-SPI semantic observation is unavailable in the current session",
            true,
        ));
    }
    if !executable_in_path("gdbus") {
        return Err((
            "EXECUTABLE_NOT_FOUND",
            "The gdbus executable is required for AT-SPI observation",
            true,
        ));
    }
    let options = ObservationOptions::from_input(input)?;
    let records = collect_accessibles(options)?;
    if matches!(action, "find_element" | "click" | "focus") {
        return semantic_action(action, input, &records);
    }
    let windows = records
        .iter()
        .map(|record| {
            let mut value = json!({
                "path": record.path,
                "bus_name": record.bus,
                "depth": record.depth,
                "role": record.role,
            });
            if let Some(title) = &record.title {
                value["title"] = Value::String(title.clone());
            }
            value
        })
        .collect::<Vec<_>>();
    let result = match action {
        "list_windows" => json!({
            "available": true,
            "ready": true,
            "backend": "atspi2-gdbus",
            "limited": true,
            "windows": windows,
        }),
        "observe" | "inspect_elements" => json!({
            "available": true,
            "ready": true,
            "backend": "atspi2-gdbus",
            "limited": true,
            "permission": "granted",
            "windows": windows,
        }),
        "observe_summary" => json!({
            "available": true,
            "ready": true,
            "backend": "atspi2-gdbus",
            "limited": true,
            "permission": "granted",
            "window_count": records.len(),
            "windows": windows.iter().take(32).collect::<Vec<_>>(),
        }),
        _ => unreachable!("action was checked above"),
    };
    serde_json::to_string(&result).map_err(|_| {
        (
            "INTERNAL_ERROR",
            "AT-SPI observation could not be encoded",
            true,
        )
    })
}

#[derive(Clone, Copy)]
struct ObservationOptions {
    max_items: usize,
    max_depth: usize,
}

impl ObservationOptions {
    fn from_input(
        input: &BTreeMap<String, String>,
    ) -> Result<Self, (&'static str, &'static str, bool)> {
        let max_items = parse_bounded(input, "max_items", 64, 1, MAX_ITEMS)?;
        let max_depth = parse_bounded(input, "max_depth", 4, 0, MAX_DEPTH)?;
        Ok(Self {
            max_items,
            max_depth,
        })
    }
}

fn parse_bounded(
    input: &BTreeMap<String, String>,
    name: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, (&'static str, &'static str, bool)> {
    let Some(value) = input.get(name) else {
        return Ok(default);
    };
    let parsed = value
        .parse::<usize>()
        .map_err(|_| ("INVALID_INPUT", "AT-SPI bounds must be integers", false))?;
    if !(min..=max).contains(&parsed) {
        return Err((
            "INVALID_INPUT",
            "AT-SPI bounds are outside the allowed range",
            false,
        ));
    }
    Ok(parsed)
}

#[derive(Debug)]
struct AccessibleRecord {
    bus: String,
    path: String,
    depth: usize,
    title: Option<String>,
    role: String,
    automation_id: Option<String>,
}

fn collect_accessibles(
    options: ObservationOptions,
) -> Result<Vec<AccessibleRecord>, (&'static str, &'static str, bool)> {
    let mut queue = VecDeque::from([(
        AT_SPI_DESTINATION.to_string(),
        AT_SPI_ROOT.to_string(),
        0usize,
    )]);
    let mut visited = HashSet::new();
    let mut records = Vec::with_capacity(options.max_items);
    let deadline = Instant::now() + Duration::from_secs(10);
    while let Some((bus, path, depth)) = queue.pop_front() {
        if Instant::now() >= deadline {
            return Err(query_error(QueryError::Timeout));
        }
        if !visited.insert((bus.clone(), path.clone())) {
            continue;
        }
        if depth > 0 {
            let title = query_property(&bus, &path, "Name")
                .ok()
                .filter(|value| !value.is_empty());
            let role = query_string_at(&bus, &path, "GetRoleName")
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "unknown".to_string());
            records.push(AccessibleRecord {
                bus: bus.clone(),
                path: path.clone(),
                depth,
                title,
                role,
                automation_id: query_property(&bus, &path, "AccessibleId")
                    .ok()
                    .filter(|value| !value.is_empty()),
            });
            if records.len() >= options.max_items {
                break;
            }
        }
        if depth >= options.max_depth {
            continue;
        }
        let output =
            run_call(&bus, &path, AT_SPI_INTERFACE, "GetChildren", &[]).map_err(query_error)?;
        for (child_bus, child_path) in parse_object_references(&output) {
            if queue.len() + records.len() >= options.max_items.saturating_mul(2) {
                break;
            }
            queue.push_back((child_bus, child_path, depth.saturating_add(1)));
        }
    }
    Ok(records)
}

fn query_children(path: &str) -> Result<Vec<String>, QueryError> {
    let output = run_gdbus(path, "GetChildren")?;
    Ok(parse_object_paths(&output))
}

fn query_string_at(bus: &str, path: &str, method: &str) -> Result<String, QueryError> {
    let output = run_call(bus, path, AT_SPI_INTERFACE, method, &[])?;
    parse_first_quoted_string(&output).ok_or(QueryError::InvalidOutput)
}

fn query_property(bus: &str, path: &str, name: &str) -> Result<String, QueryError> {
    let output = run_call(
        bus,
        path,
        "org.freedesktop.DBus.Properties",
        "Get",
        &[AT_SPI_INTERFACE, name],
    )?;
    parse_first_quoted_string(&output).ok_or(QueryError::InvalidOutput)
}

fn semantic_action(
    action: &str,
    input: &BTreeMap<String, String>,
    records: &[AccessibleRecord],
) -> Result<String, (&'static str, &'static str, bool)> {
    let name = input.get("name").filter(|name| !name.is_empty());
    let automation_id = input.get("automation_id").filter(|name| !name.is_empty());
    let role = input.get("role");
    if name.is_none() && automation_id.is_none() {
        return Err((
            "INVALID_INPUT",
            "AT-SPI requires a semantic name or automation_id",
            false,
        ));
    }
    let matches = records
        .iter()
        .filter(|record| {
            name.is_none_or(|expected| record.title.as_ref() == Some(expected))
                && automation_id
                    .is_none_or(|expected| record.automation_id.as_ref() == Some(expected))
                && role.is_none_or(|expected| record.role.eq_ignore_ascii_case(expected))
        })
        .collect::<Vec<_>>();
    let record =
        match matches.as_slice() {
            [record] => *record,
            [] => {
                return Err((
                    "FILE_NOT_FOUND",
                    "The AT-SPI semantic target was not found within the observation bounds",
                    true,
                ))
            }
            _ => return Err((
                "CONFLICT",
                "The AT-SPI semantic target is ambiguous; refine its name, role, or automation_id",
                true,
            )),
        };
    if action != "find_element" {
        let output = if action == "focus" {
            verify_identity(record)?;
            run_call(
                &record.bus,
                &record.path,
                "org.a11y.atspi.Component",
                "GrabFocus",
                &[],
            )
        } else {
            let count = run_call(
                &record.bus,
                &record.path,
                "org.freedesktop.DBus.Properties",
                "Get",
                &["org.a11y.atspi.Action", "NActions"],
            )
            .map_err(query_error)?;
            let count = count
                .split(|value: char| !value.is_ascii_alphanumeric() && value != '-')
                .filter_map(|value| value.parse::<i32>().ok())
                .next_back()
                .unwrap_or(0);
            if count <= 0 {
                return Err((
                    "UNSUPPORTED_PLATFORM",
                    "The AT-SPI element has no semantic action",
                    true,
                ));
            }
            verify_identity(record)?;
            run_call(
                &record.bus,
                &record.path,
                "org.a11y.atspi.Action",
                "DoAction",
                &["0"],
            )
        }
        .map_err(query_error)?;
        if output.trim() != "(true,)" {
            return Err((
                "PERMISSION_REQUIRED",
                "The AT-SPI semantic action was refused",
                true,
            ));
        }
    }
    Ok(json!({"available": true, "ready": true, "backend": "atspi2-gdbus", "action": action, "performed": action != "find_element", "element": {"bus_name": record.bus, "path": record.path, "name": record.title, "role": record.role, "automation_id": record.automation_id}}).to_string())
}

fn verify_identity(record: &AccessibleRecord) -> Result<(), (&'static str, &'static str, bool)> {
    let name = query_property(&record.bus, &record.path, "Name").map_err(query_error)?;
    let automation_id =
        query_property(&record.bus, &record.path, "AccessibleId").map_err(query_error)?;
    let role = query_string_at(&record.bus, &record.path, "GetRoleName").map_err(query_error)?;
    if record.title.as_deref() != (!name.is_empty()).then_some(name.as_str())
        || record.automation_id.as_deref()
            != (!automation_id.is_empty()).then_some(automation_id.as_str())
        || record.role != role
    {
        return Err((
            "CONFLICT",
            "The AT-SPI target identity changed since observation",
            true,
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueryError {
    Missing,
    Failed,
    Timeout,
    TooLarge,
    InvalidOutput,
}

fn query_error(error: QueryError) -> (&'static str, &'static str, bool) {
    match error {
        QueryError::Missing => (
            "EXECUTABLE_NOT_FOUND",
            "The gdbus executable or AT-SPI session bus is unavailable",
            true,
        ),
        QueryError::Failed => (
            "PERMISSION_REQUIRED",
            "The AT-SPI registry query failed for the current session",
            true,
        ),
        QueryError::Timeout => (
            "PROCESS_TIMEOUT",
            "The AT-SPI query exceeded its bounded time limit",
            true,
        ),
        QueryError::TooLarge => (
            "FILE_TOO_LARGE",
            "The AT-SPI registry response exceeds the bounded output limit",
            true,
        ),
        QueryError::InvalidOutput => (
            "INTERNAL_ERROR",
            "The AT-SPI registry returned an invalid response",
            true,
        ),
    }
}

fn run_gdbus(path: &str, method: &str) -> Result<String, QueryError> {
    run_call(AT_SPI_DESTINATION, path, AT_SPI_INTERFACE, method, &[])
}

fn run_call(
    destination: &str,
    path: &str,
    interface: &str,
    method: &str,
    arguments: &[&str],
) -> Result<String, QueryError> {
    if !valid_bus_name(destination) || !valid_object_path(path) || !valid_method(method) {
        return Err(QueryError::InvalidOutput);
    }
    let address = bus_address()?;
    if address.is_empty() || address.len() > MAX_ADDRESS_BYTES {
        return Err(QueryError::InvalidOutput);
    }
    let method = format!("{interface}.{method}");
    let path_env = std::env::var_os("PATH");
    let mut command = Command::new("gdbus");
    command
        .env_clear()
        .args([
            "call",
            "--address",
            address.as_str(),
            "--dest",
            destination,
            "--object-path",
            path,
            "--method",
            method.as_str(),
        ])
        .arg("--")
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C");
    if let Some(path_env) = path_env {
        command.env("PATH", path_env);
    }
    run_command(command)
}

fn bus_address() -> Result<String, QueryError> {
    if let Ok(address) = std::env::var("AT_SPI_BUS_ADDRESS") {
        if !address.is_empty() && address.len() <= MAX_ADDRESS_BYTES {
            return Ok(address);
        }
        return Err(QueryError::InvalidOutput);
    }
    let mut command = Command::new("gdbus");
    command
        .env_clear()
        .args([
            "call",
            "--session",
            "--dest",
            "org.a11y.Bus",
            "--object-path",
            "/org/a11y/bus",
            "--method",
            "org.a11y.Bus.GetAddress",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C");
    for name in [
        "PATH",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "HOME",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let address =
        parse_first_quoted_string(&run_command(command)?).ok_or(QueryError::InvalidOutput)?;
    if address.is_empty() || address.len() > MAX_ADDRESS_BYTES {
        return Err(QueryError::InvalidOutput);
    }
    Ok(address)
}

fn run_command(mut command: Command) -> Result<String, QueryError> {
    let mut child = command.spawn().map_err(|_| QueryError::Missing)?;
    let stdout = child.stdout.take().ok_or(QueryError::Failed)?;
    let stderr = child.stderr.take().ok_or(QueryError::Failed)?;
    let stdout_reader = thread::spawn(|| read_capped(stdout));
    let stderr_reader = thread::spawn(|| read_capped(stderr));
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(QueryError::Timeout);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(QueryError::Failed);
            }
        }
    };
    let (stdout, stdout_too_large) = stdout_reader.join().unwrap_or_default();
    let (_stderr, stderr_too_large) = stderr_reader.join().unwrap_or_default();
    if stdout_too_large || stderr_too_large {
        return Err(QueryError::TooLarge);
    }
    if !status.success() {
        return Err(QueryError::Failed);
    }
    String::from_utf8(stdout).map_err(|_| QueryError::InvalidOutput)
}

fn read_capped<R: Read>(mut reader: R) -> (Vec<u8>, bool) {
    let mut output = Vec::new();
    let mut too_large = false;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if output.len() < MAX_COMMAND_OUTPUT_BYTES {
                    let remaining = MAX_COMMAND_OUTPUT_BYTES - output.len();
                    output.extend_from_slice(&chunk[..read.min(remaining)]);
                }
                if output.len() >= MAX_COMMAND_OUTPUT_BYTES && read > 0 {
                    too_large = true;
                }
            }
            Err(_) => break,
        }
    }
    (output, too_large)
}

fn parse_first_quoted_string(value: &str) -> Option<String> {
    quoted_strings(value).into_iter().next()
}

fn quoted_strings(value: &str) -> Vec<String> {
    let mut quote = None;
    let mut escaped = false;
    let mut result = String::new();
    let mut values = Vec::new();
    for character in value.chars() {
        if let Some(expected) = quote {
            if escaped {
                result.push(match character {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '\\' => '\\',
                    '"' => '"',
                    '\'' => '\'',
                    other => other,
                });
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == expected {
                values.push(std::mem::take(&mut result));
                quote = None;
                if values.len() >= MAX_ITEMS * 2 {
                    break;
                }
            } else {
                result.push(character);
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        }
    }
    values
}

fn parse_object_references(value: &str) -> Vec<(String, String)> {
    let values = quoted_strings(value);
    let mut seen = HashSet::new();
    values
        .windows(2)
        .filter_map(|pair| {
            let bus = &pair[0];
            let path = &pair[1];
            (valid_bus_name(bus)
                && valid_object_path(path)
                && path != "/org/a11y/atspi/null"
                && seen.insert((bus.clone(), path.clone())))
            .then(|| (bus.clone(), path.clone()))
        })
        .take(MAX_ITEMS)
        .collect()
}

fn valid_bus_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.contains('.')
        && value
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, ':' | '.' | '_' | '-'))
}

fn parse_object_paths(value: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    let characters = value.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < characters.len() {
        if characters[index] != '/' {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < characters.len()
            && (characters[index].is_ascii_alphanumeric() || characters[index] == '_')
        {
            index += 1;
        }
        while index < characters.len() && characters[index] == '/' {
            let segment_start = index + 1;
            let mut cursor = segment_start;
            while cursor < characters.len()
                && (characters[cursor].is_ascii_alphanumeric() || characters[cursor] == '_')
            {
                cursor += 1;
            }
            if cursor == segment_start {
                break;
            }
            index = cursor;
        }
        let candidate = characters[start..index].iter().collect::<String>();
        let boundary = index == characters.len()
            || matches!(
                characters[index],
                ' ' | '\t' | '\r' | '\n' | ',' | ')' | ']' | '}' | '\'' | '"'
            );
        if boundary && valid_object_path(&candidate) && seen.insert(candidate.clone()) {
            paths.push(candidate);
            if paths.len() >= MAX_ITEMS {
                break;
            }
        }
        if index == start {
            index += 1;
        }
    }
    paths
}

fn valid_object_path(path: &str) -> bool {
    if path.len() > MAX_OBJECT_PATH_BYTES || !path.starts_with('/') {
        return false;
    }
    if path == "/" {
        return true;
    }
    path.split('/').skip(1).all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
    })
}

fn valid_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= 64
        && method
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn status(available: bool, ready: bool, reason: Option<&str>, backend: &str) -> String {
    let actions = ACTIONS
        .iter()
        .map(|action| format!(r#""{}""#, action))
        .collect::<Vec<_>>()
        .join(",");
    let reason = reason
        .map(|value| format!(r#","reason":"{}","readinessReason":"{}""#, value, value))
        .unwrap_or_default();
    format!(
        r#"{{"available":{},"ready":{},"backend":"{}","supportedActions":[{}]{}}}"#,
        available, ready, backend, actions, reason
    )
}

fn env_present(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn executable_in_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|directory| directory.join(name).is_file())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_first_quoted_string, parse_object_paths, parse_object_references, semantic_action,
        status, status_json_for, valid_object_path, AccessibleRecord,
    };

    #[test]
    fn atspi_status_never_claims_ready_without_the_bus() {
        let value = status(false, false, Some("dependency_missing"), "atspi2");
        assert!(value.contains(r#""ready":false"#));
        assert!(value.contains("dependency_missing"));
    }

    #[test]
    fn atspi_status_keeps_the_semantic_action_allowlist_bounded() {
        let value = status(true, true, None, "atspi2");
        assert!(value.contains("list_windows"));
        assert!(!value.contains("run_arbitrary_code"));
    }

    #[test]
    fn bus_presence_does_not_claim_semantic_readiness_before_a_provider_exists() {
        let value = status_json_for(true, true);
        assert!(value.contains(r#""available":true"#));
        assert!(value.contains(r#""ready":false"#));
        assert!(value.contains("provider_probe_required"));
    }

    #[test]
    fn object_path_parser_accepts_only_bounded_dbus_paths() {
        let value = parse_object_paths(
            "([(objectpath '/org/a11y/atspi/accessible/1', 'org.a11y.atspi.Registry'), objectpath '/org/a11y/atspi/accessible/2'],)",
        );
        assert_eq!(
            value,
            vec![
                "/org/a11y/atspi/accessible/1".to_string(),
                "/org/a11y/atspi/accessible/2".to_string()
            ]
        );
        assert!(valid_object_path("/org/a11y/atspi/accessible/root"));
        assert!(!valid_object_path("/org//a11y"));
        assert!(!valid_object_path("/org/a11y/atspi/accessible/../../etc"));
    }

    #[test]
    fn object_path_parser_deduplicates_and_caps_results() {
        let value = parse_object_paths(
            "objectpath '/org/a11y/atspi/accessible/1' objectpath '/org/a11y/atspi/accessible/1' /not-a-dbus-path",
        );
        assert_eq!(value, vec!["/org/a11y/atspi/accessible/1".to_string()]);
    }

    #[test]
    fn gdbus_string_parser_decodes_bounded_quoted_values() {
        assert_eq!(
            parse_first_quoted_string("('Window\\nTitle',)"),
            Some("Window\nTitle".to_string())
        );
        assert_eq!(parse_first_quoted_string("(uint32 42,)"), None);
    }

    #[test]
    fn child_references_keep_each_application_bus_even_when_root_paths_match() {
        assert_eq!(parse_object_references("([(':1.42', objectpath '/org/a11y/atspi/accessible/root'), (':1.43', objectpath '/org/a11y/atspi/accessible/root')],)"), vec![
            (":1.42".into(), "/org/a11y/atspi/accessible/root".into()),
            (":1.43".into(), "/org/a11y/atspi/accessible/root".into()),
        ]);
        assert!(parse_object_references("[('bad;destination', objectpath '/org/a11y/root'), ('', objectpath '/org/a11y/atspi/null')]").is_empty());
    }

    #[test]
    fn semantic_target_refuses_missing_and_ambiguous_matches_without_mutation() {
        let input = std::collections::BTreeMap::from([("name".into(), "Save ไทย".into())]);
        let make = |bus: &str| AccessibleRecord {
            bus: bus.into(),
            path: "/org/a11y/atspi/accessible/1".into(),
            depth: 1,
            title: Some("Save ไทย".into()),
            role: "push button".into(),
            automation_id: Some("save".into()),
        };
        assert_eq!(
            semantic_action("click", &input, &[]).unwrap_err().0,
            "FILE_NOT_FOUND"
        );
        assert_eq!(
            semantic_action("click", &input, &[make(":1.2"), make(":1.3")])
                .unwrap_err()
                .0,
            "CONFLICT"
        );
        let found: serde_json::Value = serde_json::from_str(
            &semantic_action("find_element", &input, &[make(":1.2")]).unwrap(),
        )
        .unwrap();
        assert_eq!(found["element"]["bus_name"], ":1.2");
        assert_eq!(found["performed"], false);
    }
}
