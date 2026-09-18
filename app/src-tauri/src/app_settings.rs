use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SortCriteria {
    pub key: String,
    pub order: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterCriteria {
    pub rating: u8,
    pub raw_status: String,
    #[serde(default)]
    pub edited_status: Option<String>,
    #[serde(default)]
    pub colors: Vec<String>,
}

impl Default for FilterCriteria {
    fn default() -> Self {
        Self {
            rating: 0,
            raw_status: "all".to_string(),
            edited_status: Some("all".to_string()),
            colors: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeSort {
    pub key: String,
    pub order: String,
}

impl Default for FolderTreeSort {
    fn default() -> Self {
        Self {
            key: "name".to_string(),
            order: "asc".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LastFolderState {
    #[serde(default)]
    pub current_folder_path: Option<String>,
    #[serde(default)]
    pub expanded_folders: Vec<String>,
    #[serde(default)]
    pub active_album_id: Option<String>,
    #[serde(default)]
    pub expanded_album_groups: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MyLens {
    pub maker: String,
    pub model: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PasteMode {
    Merge,
    Replace,
}

pub fn all_available_adjustments() -> HashSet<String> {
    [
        "exposure",
        "brightness",
        "contrast",
        "curves",
        "pointCurves",
        "parametricCurve",
        "curveMode",
        "highlights",
        "shadows",
        "whites",
        "blacks",
        "toneMapper",
        "temperature",
        "tint",
        "saturation",
        "vibrance",
        "hsl",
        "hue",
        "colorGrading",
        "colorCalibration",
        "clarity",
        "structure",
        "dehaze",
        "sharpness",
        "sharpnessThreshold",
        "centré",
        "lumaNoiseReduction",
        "colorNoiseReduction",
        "chromaticAberrationRedCyan",
        "chromaticAberrationBlueYellow",
        "vignetteAmount",
        "vignetteFeather",
        "vignetteMidpoint",
        "vignetteRoundness",
        "grainAmount",
        "grainRoughness",
        "grainSize",
        "lutIntensity",
        "lutName",
        "lutPath",
        "lutSize",
        "lutData",
        "lutIsSceneReferred",
        "glowAmount",
        "halationAmount",
        "flareAmount",
        "crop",
        "aspectRatio",
        "rotation",
        "flipHorizontal",
        "flipVertical",
        "orientationSteps",
        "transformDistortion",
        "transformVertical",
        "transformHorizontal",
        "transformRotate",
        "transformAspect",
        "transformScale",
        "transformXOffset",
        "transformYOffset",
        "masks",
        "lensCorrectionMode",
        "lensMaker",
        "lensModel",
        "lensDistortionAmount",
        "lensVignetteAmount",
        "lensTcaAmount",
        "lensDistortionEnabled",
        "lensTcaEnabled",
        "lensVignetteEnabled",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

pub fn default_included_adjustments() -> HashSet<String> {
    let mut defaults = all_available_adjustments();

    let off_by_default = [
        "crop",
        "aspectRatio",
        "rotation",
        "flipHorizontal",
        "flipVertical",
        "orientationSteps",
        "transformDistortion",
        "transformVertical",
        "transformHorizontal",
        "transformRotate",
        "transformAspect",
        "transformScale",
        "transformXOffset",
        "transformYOffset",
        "masks",
        "lensCorrectionMode",
        "lensMaker",
        "lensModel",
        "lensDistortionAmount",
        "lensVignetteAmount",
        "lensTcaAmount",
        "lensDistortionEnabled",
        "lensTcaEnabled",
        "lensVignetteEnabled",
    ];

    for item in off_by_default.iter() {
        defaults.remove(*item);
    }

    defaults
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopyPasteSettings {
    pub mode: PasteMode,
    #[serde(default = "default_included_adjustments")]
    pub included_adjustments: HashSet<String>,
    #[serde(default)]
    pub known_adjustments: HashSet<String>,
    #[serde(default)]
    pub auto_sync: bool,
}

impl Default for CopyPasteSettings {
    fn default() -> Self {
        Self {
            mode: PasteMode::Merge,
            included_adjustments: default_included_adjustments(),
            known_adjustments: all_available_adjustments(),
            auto_sync: false,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: String,
    pub name: String,
    pub file_format: String,
    pub jpeg_quality: u8,
    pub enable_resize: bool,
    pub resize_mode: String,
    pub resize_value: u32,
    pub dont_enlarge: bool,
    pub keep_metadata: bool,
    pub strip_gps: bool,
    pub filename_template: String,
    pub enable_watermark: bool,
    pub watermark_path: Option<String>,
    pub watermark_anchor: Option<String>,
    pub watermark_scale: u32,
    pub watermark_spacing: u32,
    pub watermark_opacity: u32,
    #[serde(default)]
    pub export_masks: Option<bool>,
    #[serde(default)]
    pub preserve_folders: Option<bool>,
    #[serde(default)]
    pub last_export_path: Option<String>,
}

pub fn default_export_presets() -> Vec<ExportPreset> {
    vec![
        ExportPreset {
            id: "default-hq".to_string(),
            name: "High Quality".to_string(),
            file_format: "jpeg".to_string(),
            jpeg_quality: 95,
            enable_resize: false,
            resize_mode: "longEdge".to_string(),
            resize_value: 2048,
            dont_enlarge: true,
            keep_metadata: true,
            strip_gps: false,
            filename_template: "{original_filename}".to_string(),
            enable_watermark: false,
            watermark_path: None,
            watermark_anchor: Some("bottomRight".to_string()),
            watermark_scale: 10,
            watermark_spacing: 5,
            watermark_opacity: 75,
            export_masks: Some(false),
            preserve_folders: Some(false),
            last_export_path: None,
        },
        ExportPreset {
            id: "default-fast".to_string(),
            name: "Fast (Web)".to_string(),
            file_format: "jpeg".to_string(),
            jpeg_quality: 80,
            enable_resize: true,
            resize_mode: "width".to_string(),
            resize_value: 2048,
            dont_enlarge: true,
            keep_metadata: false,
            strip_gps: true,
            filename_template: "{original_filename}_web".to_string(),
            enable_watermark: false,
            watermark_path: None,
            watermark_anchor: Some("bottomRight".to_string()),
            watermark_scale: 10,
            watermark_spacing: 5,
            watermark_opacity: 75,
            export_masks: Some(false),
            preserve_folders: Some(false),
            last_export_path: None,
        },
    ]
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub left_panel_width: u32,
    pub right_panel_width: u32,
    pub left_top_height: u32,
    pub right_top_height: u32,
    pub panel_layout: HashMap<String, Vec<String>>,
    pub active_panels: HashMap<String, Option<String>>,
    pub panel_switcher_placement: HashMap<String, String>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        let mut panel_layout = HashMap::new();
        #[allow(unused)]
        let mut left_top = vec![
            "metadata".to_string(),
            "folderTree".to_string(),
            "export".to_string(),
        ];

        #[cfg(feature = "tethering")]
        left_top.push("tethering".to_string());

        panel_layout.insert("leftTop".to_string(), left_top);
        panel_layout.insert("leftBottom".to_string(), vec![]);

        panel_layout.insert(
            "rightTop".to_string(),
            vec![
                "adjustments".to_string(),
                "crop".to_string(),
                "masks".to_string(),
                "ai".to_string(),
                "presets".to_string(),
            ],
        );
        panel_layout.insert("rightBottom".to_string(), vec![]);

        let mut active_panels = HashMap::new();
        active_panels.insert("leftTop".to_string(), Some("folderTree".to_string()));
        active_panels.insert("leftBottom".to_string(), None);
        active_panels.insert("rightTop".to_string(), Some("adjustments".to_string()));
        active_panels.insert("rightBottom".to_string(), None);

        let mut panel_switcher_placement = HashMap::new();
        panel_switcher_placement.insert("leftTop".to_string(), "bottom".to_string());
        panel_switcher_placement.insert("leftBottom".to_string(), "bottom".to_string());
        panel_switcher_placement.insert("rightTop".to_string(), "right".to_string());
        panel_switcher_placement.insert("rightBottom".to_string(), "right".to_string());

        Self {
            left_panel_width: 320,
            right_panel_width: 320,
            left_top_height: 450,
            right_top_height: 450,
            panel_layout,
            active_panels,
            panel_switcher_placement,
        }
    }
}

pub fn default_linear_raw_mode() -> String {
    "auto".to_string()
}

pub fn default_tagging_shortcuts_option() -> Option<Vec<String>> {
    Some(vec![
        "portrait".to_string(),
        "landscape".to_string(),
        "architecture".to_string(),
        "travel".to_string(),
        "street".to_string(),
        "family".to_string(),
        "nature".to_string(),
        "food".to_string(),
        "event".to_string(),
    ])
}

pub fn default_adjustment_visibility() -> HashMap<String, bool> {
    let mut map = HashMap::new();
    map.insert("sharpening".to_string(), true);
    map.insert("presence".to_string(), true);
    map.insert("noiseReduction".to_string(), true);
    map.insert("chromaticAberration".to_string(), false);
    map.insert("vignette".to_string(), true);
    map.insert("colorCalibration".to_string(), false);
    map.insert("grain".to_string(), true);
    map
}

pub fn default_open_tree_sections() -> Vec<String> {
    vec!["current".to_string()]
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub last_root_path: Option<String>,
    #[serde(default)]
    pub root_folders: Vec<String>,
    #[serde(default)]
    pub pinned_folders: Vec<String>,
    pub editor_preview_resolution: Option<u32>,
    #[serde(default)]
    pub small_thumbnail_resolution: Option<u32>,
    #[serde(default)]
    pub medium_thumbnail_resolution: Option<u32>,
    #[serde(default)]
    pub enable_zoom_hifi: Option<bool>,
    #[serde(default)]
    pub use_full_dpi_rendering: Option<bool>,
    #[serde(default)]
    pub high_res_zoom_multiplier: Option<f32>,
    #[serde(default)]
    pub enable_live_previews: Option<bool>,
    #[serde(default)]
    pub live_preview_quality: Option<String>,
    pub sort_criteria: Option<SortCriteria>,
    pub filter_criteria: Option<FilterCriteria>,
    pub theme: Option<String>,
    #[serde(default)]
    pub font_family: Option<String>,
    pub decorations: Option<bool>,
    #[serde(alias = "comfyuiAddress")]
    pub ai_connector_address: Option<String>,
    pub last_folder_state: Option<LastFolderState>,
    pub ui_visibility: Option<Value>,
    pub enable_ai_tagging: Option<bool>,
    pub tagging_thread_count: Option<u32>,
    #[serde(default = "default_tagging_shortcuts_option")]
    pub tagging_shortcuts: Option<Vec<String>>,
    #[serde(default)]
    pub custom_ai_tags: Option<Vec<String>>,
    #[serde(default)]
    pub ai_tag_count: Option<u32>,
    pub thumbnail_size: Option<String>,
    pub thumbnail_aspect_ratio: Option<String>,
    pub ai_provider: Option<String>,
    #[serde(default = "default_adjustment_visibility")]
    pub adjustment_visibility: HashMap<String, bool>,
    #[serde(default = "default_open_tree_sections")]
    pub open_tree_sections: Vec<String>,
    #[serde(default)]
    pub copy_paste_settings: CopyPasteSettings,
    #[serde(default)]
    pub raw_highlight_compression: Option<f32>,
    #[serde(default)]
    pub processing_backend: Option<String>,
    #[serde(default)]
    pub linux_gpu_optimization: Option<bool>,
    #[serde(default)]
    pub linux_gpu_optimization_migrated_v1: Option<bool>,
    #[serde(default)]
    pub library_view_mode: Option<String>,
    #[serde(default = "default_export_presets")]
    pub export_presets: Vec<ExportPreset>,
    #[serde(default)]
    pub my_lenses: Option<Vec<MyLens>>,
    #[serde(default)]
    pub enable_folder_image_counts: Option<bool>,
    #[serde(default)]
    pub display_edit_icon: Option<bool>,
    #[serde(default = "default_linear_raw_mode")]
    pub linear_raw_mode: String,
    #[serde(default)]
    pub enable_xmp_sync: Option<bool>,
    #[serde(default)]
    pub create_xmp_if_missing: Option<bool>,
    #[serde(default)]
    pub is_waveform_visible: Option<bool>,
    #[serde(default)]
    pub waveform_height: Option<u32>,
    #[serde(default)]
    pub active_waveform_channel: Option<String>,
    #[serde(default)]
    pub use_wgpu_renderer: Option<bool>,
    #[serde(default)]
    pub canvas_input_mode: Option<String>,
    #[serde(default)]
    pub zoom_speed_multiplier: Option<f32>,
    #[serde(default)]
    pub keybinds: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub thumbnail_worker_threads: Option<u32>,
    #[serde(default)]
    pub image_cache_size: Option<u32>,
    #[serde(default)]
    pub tonemapper_override_enabled: Option<bool>,
    #[serde(default)]
    pub default_raw_tonemapper: Option<String>,
    #[serde(default)]
    pub default_non_raw_tonemapper: Option<String>,
    #[serde(default)]
    pub enable_focus_mode: Option<bool>,
    #[serde(default)]
    pub folder_icons: Option<HashMap<String, String>>,
    #[serde(default)]
    pub raw_preprocessing_color_nr: Option<f32>,
    #[serde(default)]
    pub raw_preprocessing_sharpening: Option<f32>,
    #[serde(default)]
    pub apply_preprocessing_to_non_raws: Option<bool>,
    #[serde(default)]
    pub exif_overlay: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub folder_tree_sort: Option<FolderTreeSort>,
    #[serde(default)]
    pub library_display_mode: Option<String>,
    #[serde(default)]
    pub grouping: Option<String>,
    #[serde(default)]
    pub require_matching_exif: Option<bool>,
    #[serde(default)]
    pub group_edited_files: Option<bool>,
    #[serde(default, skip_serializing)] // legacy
    #[allow(dead_code)]
    pub group_associated_files: Option<bool>,
    #[serde(default, skip_serializing)] // legacy
    #[allow(dead_code)]
    pub group_preferred_type: Option<String>,
    #[serde(default)]
    pub always_decode_raw_thumbnails: Option<bool>,
    #[serde(default)]
    pub workspace: WorkspaceState,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            last_root_path: None,
            root_folders: Vec::new(),
            pinned_folders: Vec::new(),
            small_thumbnail_resolution: Some(480),
            medium_thumbnail_resolution: Some(1280),
            #[cfg(target_os = "android")]
            editor_preview_resolution: Some(1280),
            #[cfg(not(target_os = "android"))]
            editor_preview_resolution: Some(1920),
            enable_zoom_hifi: Some(true),
            use_full_dpi_rendering: Some(false),
            enable_live_previews: Some(true),
            live_preview_quality: Some("high".to_string()),
            sort_criteria: None,
            filter_criteria: None,
            theme: Some("dark".to_string()),
            font_family: None,
            decorations: Some(false),
            ai_connector_address: None,
            last_folder_state: None,
            ui_visibility: None,
            enable_ai_tagging: Some(false),
            tagging_thread_count: Some(3),
            tagging_shortcuts: default_tagging_shortcuts_option(),
            custom_ai_tags: Some(Vec::new()),
            ai_tag_count: Some(10),
            #[cfg(target_os = "android")]
            thumbnail_size: Some("small".to_string()),
            #[cfg(not(target_os = "android"))]
            thumbnail_size: Some("medium".to_string()),
            thumbnail_aspect_ratio: Some("cover".to_string()),
            ai_provider: Some("cpu".to_string()),
            adjustment_visibility: default_adjustment_visibility(),
            open_tree_sections: default_open_tree_sections(),
            copy_paste_settings: CopyPasteSettings::default(),
            raw_highlight_compression: Some(2.5),
            processing_backend: Some("auto".to_string()),
            linux_gpu_optimization: Some(false),
            linux_gpu_optimization_migrated_v1: Some(true),
            library_view_mode: Some("flat".to_string()),
            export_presets: default_export_presets(),
            my_lenses: Some(Vec::new()),
            #[cfg(target_os = "android")]
            high_res_zoom_multiplier: Some(0.75),
            #[cfg(not(target_os = "android"))]
            high_res_zoom_multiplier: Some(1.0),
            enable_folder_image_counts: Some(false),
            display_edit_icon: Some(true),
            linear_raw_mode: default_linear_raw_mode(),
            enable_xmp_sync: Some(true),
            create_xmp_if_missing: Some(false),
            is_waveform_visible: Some(false),
            waveform_height: Some(220),
            active_waveform_channel: Some("luma".to_string()),
            #[cfg(any(target_os = "linux", target_os = "android"))]
            use_wgpu_renderer: Some(false),
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            use_wgpu_renderer: Some(true),
            canvas_input_mode: Some("mouse".to_string()),
            zoom_speed_multiplier: Some(1.0),
            keybinds: HashMap::new(),
            #[cfg(target_os = "android")]
            thumbnail_worker_threads: Some(2),
            #[cfg(not(target_os = "android"))]
            thumbnail_worker_threads: Some(4),
            #[cfg(target_os = "android")]
            image_cache_size: Some(2),
            #[cfg(not(target_os = "android"))]
            image_cache_size: Some(5),
            tonemapper_override_enabled: Some(false),
            default_raw_tonemapper: Some("agx".to_string()),
            default_non_raw_tonemapper: Some("basic".to_string()),
            enable_focus_mode: Some(false),
            folder_icons: Some(HashMap::new()),
            raw_preprocessing_color_nr: Some(0.5),
            raw_preprocessing_sharpening: Some(0.35),
            apply_preprocessing_to_non_raws: Some(false),
            exif_overlay: Some("off".to_string()),
            language: Some("en".to_string()),
            folder_tree_sort: Some(FolderTreeSort::default()),
            library_display_mode: Some("grid".to_string()),
            grouping: Some("off".to_string()),
            require_matching_exif: Some(false),
            group_edited_files: Some(true),
            group_associated_files: Some(false),
            group_preferred_type: Some("raw".to_string()),
            always_decode_raw_thumbnails: Some(false),
            workspace: WorkspaceState::default(),
        }
    }
}

pub fn get_settings_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let settings_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    if !settings_dir.exists() {
        fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;
    }

    Ok(settings_dir.join("settings.json"))
}

/// Why [`read_settings_file`] could not produce an [`AppSettings`] (B-194,
/// mirroring D-326's `apelles_project::LoadManifestError` — read that one
/// first, this is the same shape applied to `settings.json`).
///
/// **What it is:** a *typed* distinction between the one failure that
/// legitimately means "first run, there is no settings file yet" —
/// [`Self::NotFound`] — and every other failure, which mean *a settings file
/// exists and we could not read it*, so there is real user configuration on
/// disk a caller must not silently paper over with defaults.
///
/// **Why it is a type and not a string.** The pre-fix `load_settings` did
/// `serde_json::from_str(&content).unwrap_or_default()` — so a transient read
/// glitch or a half-written/corrupt `settings.json` silently became
/// `AppSettings::default()`. Because a fresh default trips
/// `is_first_migration` a few lines later, `load_settings` then wrote that
/// default straight back over the user's real file before anyone could
/// notice anything was wrong. See `docs/BUGS.md` B-194.
#[derive(Debug, thiserror::Error)]
pub enum LoadSettingsError {
    /// `settings.json` genuinely is not there (`io::ErrorKind::NotFound`).
    /// The **only** variant on which substituting [`AppSettings::default`] is
    /// correct.
    #[error("read {path}: {source}")]
    NotFound {
        path: String,
        source: std::io::Error,
    },
    /// A real I/O failure reading it — permissions, a bad descriptor, a
    /// transient failure under memory pressure. The file may well exist and
    /// be perfectly good; we just could not read it this time.
    #[error("read {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    /// It exists and was read, but is not valid JSON, or does not match
    /// [`AppSettings`]'s shape (truncated, half-written by a non-atomic
    /// writer, corrupted, hand-edited into something invalid).
    #[error("parse {path}: {source}")]
    Parse {
        path: String,
        source: serde_json::Error,
    },
}

impl LoadSettingsError {
    /// Classify a `std::io::Error` from reading `settings.json`: a
    /// `NotFound` becomes [`Self::NotFound`], everything else [`Self::Io`].
    fn io(path: &Path, source: std::io::Error) -> Self {
        let path = path.display().to_string();
        if source.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound { path, source }
        } else {
            Self::Io { path, source }
        }
    }

    /// True only when `settings.json` genuinely does not exist — the single
    /// case in which a caller may legitimately substitute
    /// [`AppSettings::default`] and go on to write it. Everything else means
    /// "there is a real file here": refuse, don't overwrite (B-194).
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::NotFound { .. })
    }
}

impl From<LoadSettingsError> for String {
    fn from(e: LoadSettingsError) -> Self {
        e.to_string()
    }
}

/// Read and parse `settings.json` from `path`, with no defaulting and no
/// migration — a caller decides what [`LoadSettingsError::NotFound`] means
/// (first run: default) versus every other variant (a real file exists and
/// failed to load: propagate, never overwrite). Split out of [`load_settings`]
/// so it is testable without a real [`AppHandle`].
///
/// Reads directly rather than `path.exists()` then `read_to_string` (the
/// pre-fix shape) so there is no separate stat to race against — the same
/// reasoning as `apelles_project::load_manifest` (D-326).
fn read_settings_file(path: &Path) -> Result<AppSettings, LoadSettingsError> {
    let content = fs::read_to_string(path).map_err(|e| LoadSettingsError::io(path, e))?;
    serde_json::from_str(&content).map_err(|e| LoadSettingsError::Parse {
        path: path.display().to_string(),
        source: e,
    })
}

#[tauri::command]
pub fn is_tethering_supported() -> bool {
    cfg!(feature = "tethering")
}

#[tauri::command]
pub fn load_settings(app_handle: AppHandle) -> Result<AppSettings, String> {
    let path = get_settings_path(&app_handle)?;

    // B-194: `NotFound` (first run) is the only failure a fresh default may
    // stand in for. Any other error — a real I/O failure or a corrupt/
    // unparseable file — propagates instead of silently defaulting, so the
    // migration-driven write-back below can never fire over a real,
    // unreadable settings file.
    let mut settings: AppSettings = match read_settings_file(&path) {
        Ok(settings) => settings,
        Err(e) if e.is_not_found() => AppSettings::default(),
        Err(e) => return Err(e.into()),
    };

    let all_current_keys = all_available_adjustments();
    let default_included = default_included_adjustments();
    let mut settings_modified = false;

    if settings.root_folders.is_empty()
        && let Some(last) = &settings.last_root_path
    {
        settings.root_folders.push(last.clone());
        settings_modified = true;
    }

    #[cfg(target_os = "linux")]
    if !settings.linux_gpu_optimization_migrated_v1.unwrap_or(false) {
        if settings.linux_gpu_optimization == Some(true) {
            settings.linux_gpu_optimization = Some(false);
        }
        settings.linux_gpu_optimization_migrated_v1 = Some(true);
        settings_modified = true;
    }

    let is_first_migration = settings.copy_paste_settings.known_adjustments.is_empty();

    if is_first_migration {
        settings.copy_paste_settings.included_adjustments = default_included;
        settings.copy_paste_settings.known_adjustments = all_current_keys.clone();
        settings_modified = true;
    } else {
        let new_features: Vec<String> = all_current_keys
            .difference(&settings.copy_paste_settings.known_adjustments)
            .cloned()
            .collect();

        if !new_features.is_empty() {
            for feature in new_features {
                if default_included.contains(&feature) {
                    settings
                        .copy_paste_settings
                        .included_adjustments
                        .insert(feature.clone());
                }
                settings
                    .copy_paste_settings
                    .known_adjustments
                    .insert(feature);
            }
            settings_modified = true;
        }
    }

    if settings_modified && let Ok(json_string) = serde_json::to_string_pretty(&settings) {
        let _ = fs::write(&path, json_string);
    }

    Ok(settings)
}

#[tauri::command]
pub fn save_settings(settings: AppSettings, app_handle: AppHandle) -> Result<(), String> {
    let path = get_settings_path(&app_handle)?;
    let json_string = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json_string).map_err(|e| e.to_string())?;

    let state = app_handle.state::<AppState>();
    let cache_size = settings.image_cache_size.unwrap_or(5) as usize;
    state
        .decoded_image_cache
        .lock()
        .unwrap()
        .set_capacity(cache_size);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B-194: no `settings.json` at all is `NotFound` — the one case a
    /// caller may substitute [`AppSettings::default`] for.
    #[test]
    fn missing_file_is_not_found() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("settings.json");

        let err = read_settings_file(&path).expect_err("no file should not parse");

        assert!(err.is_not_found(), "expected NotFound, got: {err:?}");
    }

    /// B-194's actual bug: a `settings.json` that EXISTS but is corrupt
    /// (truncated / not valid JSON) must surface as a real error the caller
    /// can see — not be swallowed into `AppSettings::default()`, which is
    /// what the old `unwrap_or_default()` did, then had `load_settings`
    /// write the default straight back over the real file.
    #[test]
    fn corrupt_file_is_a_parse_error_not_a_silent_default() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("settings.json");
        // Deliberately not valid JSON at all — a torn/half-written write is
        // exactly this shape, not "valid JSON of the wrong schema."
        fs::write(&path, b"{\"theme\": \"dark\", \"thumbnailSize\": ").expect("write corrupt file");

        let err = read_settings_file(&path).expect_err("corrupt file must not parse");

        assert!(
            !err.is_not_found(),
            "a corrupt-but-present file must never be classified as NotFound: {err:?}"
        );
        assert!(
            matches!(err, LoadSettingsError::Parse { .. }),
            "expected Parse, got: {err:?}"
        );
        // The bug's own failure mode: never write a default over the file
        // that failed to read. `read_settings_file` never writes at all, so
        // pin that the corrupt bytes are still exactly what was there.
        let on_disk = fs::read_to_string(&path).expect("re-read");
        assert_eq!(on_disk, "{\"theme\": \"dark\", \"thumbnailSize\": ");
    }

    /// A real settings file still loads normally — the fix must not touch
    /// the happy path.
    #[test]
    fn valid_file_loads_normally() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("settings.json");
        fs::write(&path, r#"{"theme": "light"}"#).expect("write valid file");

        let settings = read_settings_file(&path).expect("valid file should load");

        assert_eq!(settings.theme, Some("light".to_string()));
    }

    /// A permission-style I/O failure (simulated here as a path whose parent
    /// is a file, not a directory, so `read_to_string` fails with a real
    /// non-`NotFound` `io::Error`) must classify as `Io`, not `NotFound` —
    /// same "there is real state here, don't default over it" reasoning.
    #[test]
    fn unreadable_path_is_io_not_not_found() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let not_a_dir = tmp.path().join("settings.json");
        fs::write(&not_a_dir, b"i am a file, not a directory").expect("write");
        // Asking to read "<file>/settings.json" fails with NotADirectory on
        // most platforms — a real I/O error distinct from NotFound.
        let bogus_path = not_a_dir.join("settings.json");

        let err = read_settings_file(&bogus_path).expect_err("must fail to read");

        assert!(
            !err.is_not_found(),
            "a real I/O failure must not be classified as NotFound: {err:?}"
        );
    }
}
