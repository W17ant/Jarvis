
(function() {
  if (!app.project) return "no active project";
  var seq = app.project.activeSequence;
  if (!seq) return "no active sequence";
  var outPath = '/Users/Antony/Desktop/Jarvis/output/premiere-renders/render_' + new Date().getTime() + '.mp4';
  // Match Source — ExtendScript constants:
  // 0 = ENCODE_ENTIRE, 1 = ENCODE_IN_TO_OUT, 2 = ENCODE_WORKAREA
  app.encoder.launchEncoder();
  var ok = app.encoder.encodeSequence(seq, outPath, "", 0, 0);
  app.encoder.startBatch();
  return "queued render to " + outPath + " — Adobe Media Encoder will finish";
})();
