"""Independent MuPDF parser and pixel oracle; production uses pdf-lib."""
import hashlib
import json
import sys

import pymupdf

assert pymupdf.VersionBind == "1.27.2.3", "use the pinned independent PDF reader"
with pymupdf.open(sys.argv[1]) as doc:
    assert doc.page_count == 2, "PDF page count mismatch"
    assert doc.metadata["title"] == "slides-9000", "PDF title mismatch"
    expected = [(255, 0, 0), (0, 0, 255)]
    if len(sys.argv) > 2:
        expected.reverse()
    pages = []
    for page, color in zip(doc, expected):
        pix = page.get_pixmap(colorspace=pymupdf.csRGB, alpha=False)
        assert (pix.width, pix.height, pix.n) == (16, 8, 3), "PDF page size mismatch"
        assert pix.samples == bytes(color) * (16 * 8), "PDF page pixels mismatch"
        pages.append({"width": pix.width, "height": pix.height, "rgbSha256": hashlib.sha256(pix.samples).hexdigest()})
    print(json.dumps({"reader": "PyMuPDF/" + pymupdf.VersionBind, "pageCount": doc.page_count, "pages": pages}))
