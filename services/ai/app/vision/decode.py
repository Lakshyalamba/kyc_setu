from io import BytesIO

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError


class DecodeError(ValueError):
    pass


def decode_image(data: bytes, *, max_pixels: int, pdf_dpi: int = 200) -> np.ndarray:
    """Bytes (JPEG, PNG or a PDF's first page) -> upright BGR uint8 image.

    EXIF orientation is applied here, so phone photos taken sideways come out the right way up.
    """
    if data[:5] == b"%PDF-":
        try:
            page = pdfium.PdfDocument(data)[0]
            pil = page.render(scale=pdf_dpi / 72).to_pil()
        except Exception as err:  # pdfium raises plain exceptions for corrupt files
            raise DecodeError("could not render the PDF") from err
    else:
        try:
            pil = Image.open(BytesIO(data))
            pil.load()
        except (UnidentifiedImageError, OSError, ValueError) as err:
            raise DecodeError("not a readable image") from err
        pil = ImageOps.exif_transpose(pil)

    if pil.width * pil.height > max_pixels:
        raise DecodeError("image is too large")
    rgb = np.asarray(pil.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
