#!/bin/bash

cd /Users/bahar/Downloads/synthetic_indust

echo "=========================================="
echo "COPYING GLB FILES TO MODEL FOLDERS"
echo "=========================================="

# برای هر فایل GLB در models_processed
find public/models_processed -name "*.glb" | while read glb_file; do
    # استخراج اسم فایل بدون مسیر و پسوند
    glb_name=$(basename "$glb_file" .glb)
    
    # پیدا کردن فایل اصلی در public/models با اسم مشابه
    # روش: جستجوی اسم GLB در کل public/models
    found=$(find public/models -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.glb" -o -name "*.gltf" \) | grep -i "$glb_name" | head -1)
    
    if [ -n "$found" ]; then
        target_dir=$(dirname "$found")
        target_file="$target_dir/$(basename "$found" | sed 's/\.[^.]*$/.glb/')"
        
        echo "📦 GLB: $glb_file"
        echo "📄 Found: $found"
        echo "📤 Target: $target_file"
        
        # کپی فایل GLB به جای فایل اصلی
        cp "$glb_file" "$target_file"
        
        # حذف فایل اصلی اگه GLB نباشه
        if [[ "$found" != *.glb ]]; then
            echo "🗑️ Removing: $found"
            rm "$found"
        fi
        
        echo "✅ Done"
        echo ""
    else
        echo "⚠️ No match found for: $glb_name"
        echo ""
    fi
done

echo "=========================================="
echo "ALL DONE!"
echo "=========================================="
