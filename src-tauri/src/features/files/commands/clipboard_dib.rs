//! 为 packed DIB 补齐显式像素偏移，避开解码器对 V4/V5 内嵌位掩码重复跳过的问题。
use super::clipboard_image::validate_dimensions;

// 只接受已知 DIB 头，所有偏移和调色板长度先检查再构造 BMP 文件头。
pub(super) fn to_bmp(dib: &[u8]) -> Result<Vec<u8>, String> {
    let invalid = || "clipboard_image_unsupported".to_string();
    let u32_at = |offset: usize| -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            dib.get(offset..offset + 4)
                .ok_or_else(invalid)?
                .try_into()
                .unwrap(),
        ))
    };
    let u16_at = |offset: usize| -> Result<u16, String> {
        Ok(u16::from_le_bytes(
            dib.get(offset..offset + 2)
                .ok_or_else(invalid)?
                .try_into()
                .unwrap(),
        ))
    };
    let header = u32_at(0)? as usize;
    if !matches!(header, 12 | 40 | 52 | 56 | 108 | 124) || dib.len() < header {
        return Err(invalid());
    }
    let (bits, colors, masks, palette_bytes) = if header == 12 {
        validate_dimensions(u32::from(u16_at(4)?), u32::from(u16_at(6)?))?;
        (u16_at(10)?, 0, 0, 3)
    } else {
        let width = u32_at(4)? as i32;
        let height = u32_at(8)? as i32;
        if width <= 0 {
            return Err(invalid());
        }
        validate_dimensions(width as u32, height.unsigned_abs())?;
        let compression = u32_at(16)?;
        let masks = if header == 40 {
            match compression {
                3 => 12,
                6 => 16,
                _ => 0,
            }
        } else {
            0
        };
        (u16_at(14)?, u32_at(32)? as usize, masks, 4)
    };
    if !matches!(bits, 1 | 4 | 8 | 16 | 24 | 32) {
        return Err(invalid());
    }
    let colors = if colors == 0 && bits <= 8 {
        1usize << bits
    } else {
        colors
    };
    let mut offset = header
        .checked_add(masks)
        .and_then(|n| {
            colors
                .checked_mul(palette_bytes)
                .and_then(|p| n.checked_add(p))
        })
        .ok_or_else(invalid)?;
    if header == 124 && u32_at(112)? as usize == offset {
        offset = offset
            .checked_add(u32_at(116)? as usize)
            .ok_or_else(invalid)?;
    }
    if offset >= dib.len() {
        return Err(invalid());
    }
    let size = u32::try_from(dib.len() + 14).map_err(|_| invalid())?;
    let mut bmp = Vec::with_capacity(size as usize);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&size.to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&((offset + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    // 部分 Chromium/截图工具以 BI_RGB 声明带 alpha mask 的 32 位图，保留其透明度。
    if header >= 108 && bits == 32 && u32_at(16)? == 0 && u32_at(52)? == 0xff000000 {
        bmp[30..34].copy_from_slice(&3u32.to_le_bytes());
        if [40, 44, 48]
            .iter()
            .all(|offset| u32_at(*offset).ok() == Some(0))
        {
            for (offset, mask) in [(40, 0xff0000u32), (44, 0xff00), (48, 0xff)] {
                bmp[14 + offset..18 + offset].copy_from_slice(&mask.to_le_bytes());
            }
        }
    }
    Ok(bmp)
}
