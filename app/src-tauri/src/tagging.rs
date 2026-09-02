// D-043: this module used to also run CLIP-based AI auto-tagging over a whole
// library folder (`start_background_indexing`, `generate_tags_with_clip`,
// `extract_color_tags` + their CLIP/HSV helpers) and a Settings-level "clear
// tags across every root folder" pair (`clear_ai_tags`, `clear_all_tags`,
// `rrdata_source_path`, `sync_xmp_for_rrdata`) — both DAM-only (folder-root
// scoped), removed with FolderTree/LibraryView (see
// docs/notes/colorist-strip.md §6). `add_tag_for_paths` / `remove_tag_for_paths`
// survive: the editor + filmstrip tagging context-menu (`TaggingSubMenu`) tags
// whatever paths are passed in, independent of any library folder concept.
use anyhow::Result;
use rayon::prelude::*;
use std::fs;
use tauri::AppHandle;

use crate::file_management::{self, parse_virtual_path};

pub const COLOR_TAG_PREFIX: &str = "color:";

fn modify_tags_for_path(
    path_str: &str,
    app_handle: &AppHandle,
    modify_fn: impl Fn(&mut Vec<String>),
) -> Result<(), String> {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);

    let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

    let mut tags = metadata.tags.unwrap_or_default();
    modify_fn(&mut tags);

    tags.sort_unstable();
    tags.dedup();

    if tags.is_empty() {
        metadata.tags = None;
    } else {
        metadata.tags = Some(tags);
    }

    let json_string = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(&sidecar_path, json_string).map_err(|e| e.to_string())?;

    if let Ok(settings) = crate::load_settings(app_handle.clone())
        && settings.enable_xmp_sync.unwrap_or(false)
    {
        let create_if_missing = settings.create_xmp_if_missing.unwrap_or(false);
        file_management::sync_metadata_to_xmp(&source_path, &metadata, create_if_missing);
    }

    Ok(())
}

#[tauri::command]
pub fn add_tag_for_paths(
    paths: Vec<String>,
    tag: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let tag_clone = tag.clone();
        if let Err(e) = modify_tags_for_path(path, &app_handle, |tags| {
            if !tags.contains(&tag_clone) {
                tags.push(tag_clone.clone());
            }
        }) {
            eprintln!("Failed to add tag to {}: {}", path, e);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn remove_tag_for_paths(
    paths: Vec<String>,
    tag: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    paths.par_iter().for_each(|path| {
        let tag_clone = tag.clone();
        if let Err(e) = modify_tags_for_path(path, &app_handle, |tags| {
            tags.retain(|t| t != &tag_clone);
        }) {
            eprintln!("Failed to remove tag from {}: {}", path, e);
        }
    });
    Ok(())
}
