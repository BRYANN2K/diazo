/** Every MCP tool is deliberately mirrored or kept outside the script capability. */
export const SCRIPT_TOOL_COVERAGE: Record<string, { sdk: string } | { excluded: string }> = {
  query_script: {
    excluded: 'Script control, documentation or audit; cannot nest inside a script.',
  },
  run_script: {
    excluded: 'Script control, documentation or audit; cannot nest inside a script.',
  },
  get_sdk_docs: {
    excluded: 'Script control, documentation or audit; cannot nest inside a script.',
  },
  revert_script_run: {
    excluded: 'Script control, documentation or audit; cannot nest inside a script.',
  },
  get_guide: {
    excluded: 'Script control, documentation or audit; cannot nest inside a script.',
  },
  search_inspiration: {
    excluded: 'Separate workflow; not exposed by the bounded canvas SDK.',
  },
  list_canvases: {
    excluded: 'Account or cross-canvas operation; scripts are bound to one canvas.',
  },
  find_in_canvas: {
    sdk: 'frames.find',
  },
  get_profile: {
    excluded: 'Account or cross-canvas operation; scripts are bound to one canvas.',
  },
  create_canvas: {
    excluded: 'Account or cross-canvas operation; scripts are bound to one canvas.',
  },
  get_canvas: {
    sdk: 'canvas.summary',
  },
  list_skills: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  get_skill: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  set_skill: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  list_guidelines: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  get_guidelines: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  get_usage: {
    excluded: 'Script control, documentation or audit; cannot nest inside a script.',
  },
  set_guidelines: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  get_tokens: {
    sdk: 'tokens.get',
  },
  create_tokens: {
    sdk: 'tokens.create',
  },
  set_tokens: {
    sdk: 'tokens.set',
  },
  set_token_themes: {
    sdk: 'tokens.themes',
  },
  get_reference: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  save_decision: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  set_status: {
    sdk: 'canvas.status',
  },
  get_comments: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  reply_to_comment: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  resolve_comment: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  get_feedback: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  report_issue: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  share_feedback: {
    excluded: 'Conversation or memory write/read stays in its dedicated permission-gated tool.',
  },
  set_canvas_pages: {
    excluded: 'Page or prototype administration is outside the SDK.',
  },
  create_canvas_page: {
    excluded: 'Page or prototype administration is outside the SDK.',
  },
  set_page_background: {
    excluded: 'Page or prototype administration is outside the SDK.',
  },
  get_prototype: {
    excluded: 'Page or prototype administration is outside the SDK.',
  },
  set_prototype_start: {
    excluded: 'Page or prototype administration is outside the SDK.',
  },
  create_frame: {
    sdk: 'frames.create',
  },
  create_live_frame: {
    excluded: 'Separate workflow; not exposed by the bounded canvas SDK.',
  },
  get_frame: {
    sdk: 'frames.html',
  },
  set_frame_html: {
    sdk: 'frames.stream',
  },
  lint_frame: {
    sdk: 'checks.lint',
  },
  check_frame: {
    sdk: 'checks.review',
  },
  get_composition: {
    sdk: 'compositions.get',
  },
  set_composition: {
    sdk: 'compositions.patch',
  },
  animate_storyboard: {
    sdk: 'compositions.storyboard',
  },
  lint_motion: {
    sdk: 'compositions.lint',
  },
  render_composition: {
    sdk: 'compositions.render',
  },
  export_frame: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  upload_asset: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  upload_font: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  generate_image: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  search_images: {
    sdk: 'search.images',
  },
  list_backgrounds: {
    excluded: 'Separate workflow; not exposed by the bounded canvas SDK.',
  },
  search_icons: {
    sdk: 'search.icons',
  },
  search_logos: {
    sdk: 'search.logos',
  },
  view_website: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  import_webpage: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  compare_with_url: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  list_linear_issues: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  get_linear_issue: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  list_components: {
    sdk: 'components.list',
  },
  get_component: {
    sdk: 'components.get',
  },
  create_component: {
    sdk: 'components.create',
  },
  update_component: {
    sdk: 'components.update',
  },
  insert_instance: {
    sdk: 'components.insert',
  },
  update_instances: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
  find_component_candidates: {
    excluded: 'Separate workflow; not exposed by the bounded canvas SDK.',
  },
  delete_component: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
  restore_component_version: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
  import_component: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
  sync_component: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
  list_libraries: {
    excluded: 'Library administration or curation; scripts only search, inspect, check and insert readable items.',
  },
  get_library: {
    excluded: 'Library administration or curation; scripts only search, inspect, check and insert readable items.',
  },
  search_library: {
    sdk: 'libraries.search',
  },
  get_library_item: {
    sdk: 'libraries.item',
  },
  insert_library_item: {
    sdk: 'libraries.insert',
  },
  import_to_library: {
    excluded: 'Library administration or curation; scripts only search, inspect, check and insert readable items.',
  },
  set_library_item: {
    excluded: 'Library administration or curation; scripts only search, inspect, check and insert readable items.',
  },
  check_library: {
    sdk: 'libraries.check',
  },
  start_library_curation: {
    excluded: 'Library administration or curation; scripts only search, inspect, check and insert readable items.',
  },
  get_library_curation: {
    excluded: 'Library administration or curation; scripts only search, inspect, check and insert readable items.',
  },
  get_component_preview: {
    excluded: 'Images must return through a dedicated screenshot tool; SDK checks return numbers.',
  },
  get_frame_screenshot: {
    excluded: 'Images must return through a dedicated screenshot tool; SDK checks return numbers.',
  },
  create_handoff: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  suggest_code_links: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  export_frame_code: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  set_code_link: {
    excluded: 'External resource, generation, upload or export; requires its dedicated tool.',
  },
  append_frame_html: {
    sdk: 'frames.stream',
  },
  edit_frame_html: {
    sdk: 'frames.edit',
  },
  update_frame: {
    sdk: 'frames.update',
  },
  list_frame_versions: {
    excluded: 'Separate workflow; not exposed by the bounded canvas SDK.',
  },
  restore_frame_version: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
  delete_frame: {
    excluded: 'Destructive or history operation; requires its dedicated tool.',
  },
}
