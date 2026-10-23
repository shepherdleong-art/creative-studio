/** Match browser mono speaker upmix: duplicate at the original level, keep stereo unchanged. */
// Must be the first filter: an earlier aresample can negotiate stereo itself,
// applying the -3dB conversion before nb_channels observes the original layout.
export const FORMULA_STEREO_FILTER = "volume='if(eq(nb_channels,1),sqrt(2),1)',aformat=sample_fmts=fltp:channel_layouts=stereo";
