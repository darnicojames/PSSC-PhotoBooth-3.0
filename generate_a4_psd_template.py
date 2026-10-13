"""
Script to generate A4 Photoprint 8-Ticket PSD Template using the Photobooth Layout tickets only.
Specs:
- Sheet Size: A4 (210 x 297 mm) @ 300 DPI = 2481 x 3509 pixels
- Color Mode: RGB 8-bit
- Layout: 8 Photobooth Tickets (4 columns x 2 rows)
- Source Ticket: photobooth-layout.psd (Layer 0, Layer 3, Layer 2, Hue/Saturation 1 copy 2)
- No decorative design overlays (no gold floral vines, no cartoons)
- Compatible with Adobe Photoshop 2019+
"""

import os
import time
from PIL import Image, ImageDraw, ImageFont
from psd_tools import PSDImage
from psd_tools.constants import Resource
from psd_tools.psd.image_resources import ResoulutionInfo, GridGuidesInfo, ImageResource

def get_font(name="arial.ttf", size=24):
    windir = os.environ.get("WINDIR", "C:\\Windows")
    font_path = os.path.join(windir, "Fonts", name)
    if os.path.exists(font_path):
        try:
            return ImageFont.truetype(font_path, size)
        except Exception:
            pass
    return ImageFont.load_default()

def create_trim_guides_image(sheet_w, sheet_h, cut_x_list, cut_y_list, margin_x, margin_y):
    im = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    
    f_guide = get_font("arialbd.ttf", 16)
    f_title = get_font("arialbd.ttf", 20)
    f_sub = get_font("arial.ttf", 14)
    
    guide_color = (225, 29, 72, 240)  # Crimson red
    dash_len = 16
    gap_len = 12
    
    # Vertical cut lines
    for cx in cut_x_list:
        y = 20
        while y < sheet_h - 20:
            draw.line([(cx, y), (cx, min(y + dash_len, sheet_h - 20))], fill=guide_color, width=2)
            y += dash_len + gap_len
        # Scissors label at top and bottom
        lbl_top = f"✂ CUT ({cx}px)"
        b = draw.textbbox((0, 0), lbl_top, font=f_guide)
        w = b[2] - b[0]
        draw.rectangle([cx - w // 2 - 6, 26, cx + w // 2 + 6, 50], fill=(255, 255, 255, 230), outline=guide_color, width=1)
        draw.text((cx - w // 2, 28), lbl_top, fill=guide_color, font=f_guide)
        
        lbl_bot = f"✂ CUT ({cx}px)"
        b2 = draw.textbbox((0, 0), lbl_bot, font=f_guide)
        w2 = b2[2] - b2[0]
        draw.rectangle([cx - w2 // 2 - 6, sheet_h - 52, cx + w2 // 2 + 6, sheet_h - 28], fill=(255, 255, 255, 230), outline=guide_color, width=1)
        draw.text((cx - w2 // 2, sheet_h - 50), lbl_bot, fill=guide_color, font=f_guide)
        
    # Horizontal cut line
    for cy in cut_y_list:
        x = 20
        while x < sheet_w - 20:
            draw.line([(x, cy), (min(x + dash_len, sheet_w - 20), cy)], fill=guide_color, width=2)
            x += dash_len + gap_len
        # Scissors label at left and right
        lbl_left = f"✂ CENTER HORIZONTAL CUT (Y: {cy}px)"
        b = draw.textbbox((0, 0), lbl_left, font=f_guide)
        w = b[2] - b[0]
        draw.rectangle([60, cy - 14, 60 + w + 12, cy + 14], fill=(255, 255, 255, 230), outline=guide_color, width=1)
        draw.text((66, cy - 10), lbl_left, fill=guide_color, font=f_guide)
        
        lbl_right = f"✂ CENTER HORIZONTAL CUT"
        b2 = draw.textbbox((0, 0), lbl_right, font=f_guide)
        w2 = b2[2] - b2[0]
        draw.rectangle([sheet_w - w2 - 76, cy - 14, sheet_w - 64, cy + 14], fill=(255, 255, 255, 230), outline=guide_color, width=1)
        draw.text((sheet_w - w2 - 70, cy - 10), lbl_right, fill=guide_color, font=f_guide)
        
    # Corner registration marks (L-marks)
    def draw_corner_mark(x, y, dx, dy, arm=35):
        draw.line([(x, y), (x + dx * arm, y)], fill=(30, 41, 59, 255), width=2)
        draw.line([(x, y), (x, y + dy * arm)], fill=(30, 41, 59, 255), width=2)

    x_min, x_max = margin_x, sheet_w - margin_x
    y_min, y_max = margin_y, sheet_h - margin_y
    draw_corner_mark(x_min, y_min, -1, -1)
    draw_corner_mark(x_max, y_min, 1, -1)
    draw_corner_mark(x_min, y_max, -1, 1)
    draw_corner_mark(x_max, y_max, 1, 1)
    
    # Top banner instructions
    title_str = "A4 PHOTOBOOTH PRINT TEMPLATE - 8 TICKETS (2481 x 3509 px @ 300 DPI) - HIDE BEFORE PRINTING"
    tb = draw.textbbox((0, 0), title_str, font=f_title)
    tw = tb[2] - tb[0]
    draw.rectangle([(sheet_w - tw) // 2 - 12, 10, (sheet_w + tw) // 2 + 12, 34], fill=(255, 255, 255, 240), outline=(225, 29, 72, 255), width=1)
    draw.text(((sheet_w - tw) // 2, 12), title_str, fill=(225, 29, 72, 255), font=f_title)
    
    # Bottom banner instructions
    sub_str = "Photobooth Layout Ticket Strips (8 Tickets per A4 Sheet) - Compatible with Adobe Photoshop 2019+ - Crop along dashed lines"
    sb = draw.textbbox((0, 0), sub_str, font=f_sub)
    sw = sb[2] - sb[0]
    draw.text(((sheet_w - sw) // 2, sheet_h - 22), sub_str, fill=(100, 116, 139, 255), font=f_sub)
    
    return im

def build_template():
    t_start = time.time()
    print("Building A4 8-Ticket Photoprint PSD Template using photobooth-layout tickets only...")
    
    SHEET_W = 2481
    SHEET_H = 3509
    TICKET_W = 580
    TICKET_H = 1514
    
    MARGIN_X = 50
    GUTTER_X = 20
    MARGIN_Y = 220
    GUTTER_Y = 40
    
    cols_x = [MARGIN_X + c * (TICKET_W + GUTTER_X) for c in range(4)]
    rows_y = [MARGIN_Y, MARGIN_Y + TICKET_H + GUTTER_Y]
    
    cut_x_list = [
        cols_x[0] + TICKET_W + GUTTER_X // 2,  # 640
        cols_x[1] + TICKET_W + GUTTER_X // 2,  # 1240
        cols_x[2] + TICKET_W + GUTTER_X // 2   # 1840
    ]
    cut_y_list = [
        rows_y[0] + TICKET_H + GUTTER_Y // 2   # 1754
    ]
    
    print(f"Columns X: {cols_x}")
    print(f"Rows Y: {rows_y}")
    print(f"Cut X: {cut_x_list}")
    print(f"Cut Y: {cut_y_list}")
    
    # 1. Extract and scale source ticket layers from photobooth-layout.psd
    print("Extracting layers from photobooth-layout.psd...")
    src_psd = PSDImage.open('photobooth-layout.psd')
    
    src_l0 = src_psd[0].composite()  # Layer 0 (Ticket Frame)
    src_l3 = src_psd[1].composite()  # Layer 3 (Pic 3)
    src_l2 = src_psd[2].composite()  # Layer 2 (Pic 2)
    src_l1 = src_psd[3].composite()  # Hue/Saturation 1 copy 2 (Pic 1)
    
    orig_w, orig_h = src_l0.size
    print(f"Original ticket frame size: {orig_w} x {orig_h}")
    
    # Scaled ticket frame
    scaled_l0 = src_l0.resize((TICKET_W, TICKET_H), Image.Resampling.LANCZOS)
    
    # Scaled blank stub ticket frame (where event text is clean solid blue)
    scaled_l0_blank = src_l0.copy()
    draw_stub = ImageDraw.Draw(scaled_l0_blank)
    sample_blue = src_l0.getpixel((460, 2100))
    draw_stub.rectangle([80, 2015, 840, 2270], fill=sample_blue)
    scaled_l0_blank = scaled_l0_blank.resize((TICKET_W, TICKET_H), Image.Resampling.LANCZOS)
    
    # Scaled pic dimensions and relative offsets
    # Pic 1: orig offset (120, 171), size (679, 415)
    pic1_w = round(679 * TICKET_W / orig_w)
    pic1_h = round(415 * TICKET_H / orig_h)
    pic1_rx = round(120 * TICKET_W / orig_w)
    pic1_ry = round(171 * TICKET_H / orig_h)
    scaled_pic1 = src_l1.resize((pic1_w, pic1_h), Image.Resampling.LANCZOS)
    
    # Pic 2: orig offset (120, 685), size (679, 415)
    pic2_w = round(679 * TICKET_W / orig_w)
    pic2_h = round(415 * TICKET_H / orig_h)
    pic2_rx = round(120 * TICKET_W / orig_w)
    pic2_ry = round(685 * TICKET_H / orig_h)
    scaled_pic2 = src_l2.resize((pic2_w, pic2_h), Image.Resampling.LANCZOS)
    
    # Pic 3: orig offset (121, 1200), size (679, 416)
    pic3_w = round(679 * TICKET_W / orig_w)
    pic3_h = round(416 * TICKET_H / orig_h)
    pic3_rx = round(121 * TICKET_W / orig_w)
    pic3_ry = round(1200 * TICKET_H / orig_h)
    scaled_pic3 = src_l3.resize((pic3_w, pic3_h), Image.Resampling.LANCZOS)
    
    # 2. Initialize new PSDImage
    psd = PSDImage.new('RGB', (SHEET_W, SHEET_H), depth=8)
    
    # 3. Add ResolutionInfo (300 DPI)
    res_info = ResoulutionInfo(
        horizontal=19660800,  # 300 * 65536
        horizontal_unit=1,
        width_unit=1,
        vertical=19660800,
        vertical_unit=1,
        height_unit=1
    )
    psd.image_resources[Resource.RESOLUTION_INFO] = ImageResource(key=Resource.RESOLUTION_INFO, data=res_info)
    
    # 4. Add Native Photoshop Guides (GridGuidesInfo)
    guide_data = [
        (MARGIN_X * 32, 0),
        (cut_x_list[0] * 32, 0),
        (cut_x_list[1] * 32, 0),
        (cut_x_list[2] * 32, 0),
        ((SHEET_W - MARGIN_X) * 32, 0),
        (MARGIN_Y * 32, 1),
        (cut_y_list[0] * 32, 1),
        ((rows_y[1] + TICKET_H) * 32, 1)
    ]
    grid_guides = GridGuidesInfo(version=1, horizontal=0, vertical=0, data=guide_data)
    psd.image_resources[Resource.GRID_AND_GUIDES_INFO] = ImageResource(key=Resource.GRID_AND_GUIDES_INFO, data=grid_guides)
    
    # 5. Background Layer (A4 Paper White)
    print("Creating A4 Paper Background...")
    bg_img = Image.new('RGB', (SHEET_W, SHEET_H), (255, 255, 255))
    bg_layer = psd.create_pixel_layer(bg_img, name='A4 Paper Background')
    psd.append(bg_layer)
    
    # 6. Assemble the 8 Ticket Groups
    ticket_names = [
        "Ticket 1 (Top Left)",
        "Ticket 2 (Top Mid-Left)",
        "Ticket 3 (Top Mid-Right)",
        "Ticket 4 (Top Right)",
        "Ticket 5 (Bottom Left)",
        "Ticket 6 (Bottom Mid-Left)",
        "Ticket 7 (Bottom Mid-Right)",
        "Ticket 8 (Bottom Right)"
    ]
    
    ticket_idx = 0
    for r in range(2):
        ty = rows_y[r]
        for c in range(4):
            tx = cols_x[c]
            t_num = ticket_idx + 1
            t_name = ticket_names[ticket_idx]
            print(f"Assembling {t_name} at ({tx}, {ty})...")
            
            group_layers = []
            
            # Layer 0: Ticket Base Frame (photobooth-layout)
            l_frame = psd.create_pixel_layer(
                scaled_l0,
                name="Ticket Frame (photobooth-layout)",
                top=ty,
                left=tx
            )
            group_layers.append(l_frame)
            
            # Layer 0 (Blank Stub Alternative, toggleable)
            l_frame_blank = psd.create_pixel_layer(
                scaled_l0_blank,
                name="Ticket Frame (Blank Stub - No Text)",
                top=ty,
                left=tx
            )
            l_frame_blank.visible = False
            group_layers.append(l_frame_blank)
            
            # Pic 3 (Layer 3)
            l_pic3 = psd.create_pixel_layer(
                scaled_pic3,
                name="Pic 3 (Blue) [Photo Slot]",
                top=ty + pic3_ry,
                left=tx + pic3_rx
            )
            group_layers.append(l_pic3)
            
            # Pic 2 (Layer 2)
            l_pic2 = psd.create_pixel_layer(
                scaled_pic2,
                name="Pic 2 (Red) [Photo Slot]",
                top=ty + pic2_ry,
                left=tx + pic2_rx
            )
            group_layers.append(l_pic2)
            
            # Pic 1 (Hue/Saturation 1 copy 2)
            l_pic1 = psd.create_pixel_layer(
                scaled_pic1,
                name="Pic 1 (Orange) [Photo Slot]",
                top=ty + pic1_ry,
                left=tx + pic1_rx
            )
            group_layers.append(l_pic1)
            
            # Create group and append to PSD
            grp = psd.create_group(group_layers, name=t_name, open_folder=(ticket_idx == 0))
            psd.append(grp)
            
            ticket_idx += 1
            
    # 7. Cut & Trim Guides Group
    print("Building Cut & Trim Guides...")
    trim_img = create_trim_guides_image(SHEET_W, SHEET_H, cut_x_list, cut_y_list, MARGIN_X, MARGIN_Y)
    l_guides = psd.create_pixel_layer(trim_img, name="Visual Cut & Trim Lines", top=0, left=0)
    grp_guides = psd.create_group([l_guides], name="Cut & Trim Guides (Hide before printing)", open_folder=True)
    psd.append(grp_guides)
    
    # 8. Save PSD
    out_psd_path = "A4_Photoprint_8_Tickets_Template.psd"
    print(f"Saving to {out_psd_path}...")
    psd.save(out_psd_path)
    
    elapsed = time.time() - t_start
    file_size_mb = os.path.getsize(out_psd_path) / (1024 * 1024)
    print(f"Successfully generated {out_psd_path} in {elapsed:.1f}s ({file_size_mb:.2f} MB)")
    
    # 9. Build high-speed composite preview using PIL directly
    print("Rendering high-speed composite preview image...")
    comp_sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (255, 255, 255, 255))
    
    # Build single ticket composite for rendering preview
    single_ticket = scaled_l0.copy()
    single_ticket.alpha_composite(scaled_pic3, (pic3_rx, pic3_ry))
    single_ticket.alpha_composite(scaled_pic2, (pic2_rx, pic2_ry))
    single_ticket.alpha_composite(scaled_pic1, (pic1_rx, pic1_ry))
    
    for r in range(2):
        ty = rows_y[r]
        for c in range(4):
            tx = cols_x[c]
            comp_sheet.alpha_composite(single_ticket, (tx, ty))
            
    # Add trim guides to preview
    comp_sheet.alpha_composite(trim_img, (0, 0))
    
    preview_path = "A4_Photoprint_8_Tickets_Preview.png"
    comp_sheet.convert("RGB").save(preview_path, format="PNG")
    print(f"Saved preview: {preview_path} ({os.path.getsize(preview_path) / 1024 / 1024:.2f} MB)")
    
    # Web thumbnail
    thumb_path = "static/previews/A4_Photoprint_8_Tickets_Thumb.png"
    thumb = comp_sheet.convert("RGB").copy()
    thumb.thumbnail((1200, 1700), Image.Resampling.LANCZOS)
    thumb.save(thumb_path, format="PNG")
    print(f"Saved web thumbnail: {thumb_path}")

if __name__ == "__main__":
    build_template()
