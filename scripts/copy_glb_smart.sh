#!/bin/bash

cd /Users/bahar/Downloads/synthetic_indust

echo "=========================================="
echo "SMART COPY GLB FILES TO MODEL FOLDERS"
echo "=========================================="

# اول لیست همه فایل‌های مدل در public/models رو بگیریم
echo "📄 Building model index..."
find public/models -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.glb" -o -name "*.gltf" \) | while read model_file; do
    model_name=$(basename "$model_file")
    model_name_noext="${model_name%.*}"
    model_dir=$(dirname "$model_file")
    
    # ذخیره در فایل موقت
    echo "$model_name_noext|$model_dir|$model_file|$model_name"
done > /tmp/model_index.txt

echo "Found $(cat /tmp/model_index.txt | wc -l | tr -d ' ') model files"

echo ""
echo "=========================================="
echo "COPYING GLB FILES"
echo "=========================================="

# برای هر GLB در models_processed
find public/models_processed -name "*.glb" | while read glb_file; do
    glb_name=$(basename "$glb_file" .glb)
    
    # حذف پیشوندهای اضافی از اسم GLB
    clean_name=$(echo "$glb_name" | sed -E 's/^(Crane_|Compressor_|ElectroMotor_|FanSanati_|FireTruck_|Hydrant_|Kapsole_|PanelBargh_|ShirAtash_|fire_hydrant_|fire-extinguisher_|electric_box_|electric-motor_|compressor_|fan_|models_|Crane_|Crane_)[0-9]+_//' | sed -E 's/_[0-9]+$//')
    
    # حذف کاراکترهای خاص
    clean_name=$(echo "$clean_name" | sed 's/[()]//g' | sed 's/  */ /g')
    
    echo ""
    echo "📦 GLB: $glb_file"
    echo "🔍 Searching for: $clean_name"
    
    # جستجوی با اسم تمیز شده
    found=$(cat /tmp/model_index.txt | grep -i "$clean_name" | head -1)
    
    # اگه پیدا نشد، با بخش اول اسم جستجو کن
    if [ -z "$found" ]; then
        first_part=$(echo "$clean_name" | cut -d' ' -f1 | cut -d'_' -f1)
        echo "   Trying first part: $first_part"
        found=$(cat /tmp/model_index.txt | grep -i "$first_part" | head -1)
    fi
    
    # اگه بازم پیدا نشد، با هر کلمه‌ای از اسم
    if [ -z "$found" ]; then
        for word in $clean_name; do
            if [ ${#word} -gt 3 ]; then
                echo "   Trying word: $word"
                found=$(cat /tmp/model_index.txt | grep -i "$word" | head -1)
                if [ -n "$found" ]; then
                    break
                fi
            fi
        done
    fi
    
    if [ -n "$found" ]; then
        # استخراج اطلاعات
        IFS='|' read -r model_name_noext model_dir model_file model_name <<< "$found"
        
        target_file="$model_dir/$(basename "$model_file" | sed 's/\.[^.]*$/.glb/')"
        
        echo "✅ Found: $model_file"
        echo "📤 Copying to: $target_file"
        
        # کپی فایل
        cp "$glb_file" "$target_file"
        
        # حذف فایل اصلی اگه GLB نباشه
        if [[ "$model_file" != *.glb ]]; then
            echo "🗑️ Removing: $model_file"
            rm "$model_file"
        fi
        
        echo "✅ Done!"
    else
        echo "❌ No match found for: $glb_name"
        echo "   Clean name: $clean_name"
    fi
done

echo ""
echo "=========================================="
echo "ALL DONE!"
echo "=========================================="
