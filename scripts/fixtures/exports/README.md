# Synthetic export assets

These tiny files are generated locally and contain no platform data.

- red.png / blue.png: 16 by 8 solid RGB PNGs generated with Python struct/zlib.
- clip.mp4: two 16 by 16 red frames generated with local FFmpeg color source, libx264, yuv420p, faststart.
- red.mpegts / blue.mpegts: MPEG-TS red/blue color sources generated with local FFmpeg; the different frames detect segment ordering/duplication.
- init.mp4 / fragment.m4s: the init and moof/mdat portions of a locally generated fragmented red MP4 (frag_keyframe+empty_moov); verifies the supported HLS EXT-X-MAP path.

Generation is a maintainer preparation step. Tests never invoke FFmpeg or ffprobe. The standalone child PATH is empty, and generated assets are served only through the strict local TLS fixture. The large resume input is clip.mp4 plus a legal 9 MiB free atom; byte/hash verification compares fixed external input to the downloaded file.

Production writes PDF with pdf-lib. Independent verification uses PyMuPDF 1.27.2.3 to parse and rasterize both pages, checking count, title, size, RGB content and page order. It never imports production PDF code.
