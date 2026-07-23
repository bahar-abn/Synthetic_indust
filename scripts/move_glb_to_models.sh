#!/bin/bash

cd /Users/bahar/Downloads/synthetic_indust

echo "=========================================="
echo "MOVING GLB FILES TO ORIGINAL MODEL FOLDERS"
echo "=========================================="
echo ""

# پیدا کردن تمام فایل‌های GLB در models_processed
find public/models_processed -name "*.glb" -type f | while read glb_file; do
    echo "=========================================="
    echo "📦 GLB: $glb_file"
    
    # استخراج اسم فایل بدون مسیر و پسوند
    glb_basename=$(basename "$glb_file" .glb)
    echo "🔍 GLB basename: $glb_basename"
    
    # پیدا کردن پوشه‌ای که این GLB از اونجا ساخته شده
    # با بررسی محتوای فایل GLB یا با استفاده از pattern matching
    # روش: اسم GLB رو به بخش‌هایی تقسیم می‌کنیم
    
    # پیدا کردن کلاس از اسم GLB
    class_name=""
    if [[ "$glb_basename" == *"Crane"* ]]; then
        class_name="Crane"
    elif [[ "$glb_basename" == *"Compressor"* ]] || [[ "$glb_basename" == *"compressor"* ]]; then
        class_name="Compressor"
    elif [[ "$glb_basename" == *"ElectroMotor"* ]] || [[ "$glb_basename" == *"electric"* ]] || [[ "$glb_basename" == *"motor"* ]]; then
        class_name="ElectroMotor"
    elif [[ "$glb_basename" == *"Fan"* ]] || [[ "$glb_basename" == *"fan"* ]]; then
        class_name="FanSanati"
    elif [[ "$glb_basename" == *"FireTruck"* ]] || [[ "$glb_basename" == *"Atego"* ]]; then
        class_name="FireTruck"
    elif [[ "$glb_basename" == *"Hydrant"* ]] || [[ "$glb_basename" == *"hydrant"* ]] || [[ "$glb_basename" == *"Hidrant"* ]]; then
        class_name="Hydrant"
    elif [[ "$glb_basename" == *"fire_hydrant"* ]] || [[ "$glb_basename" == *"ShirAtash"* ]]; then
        class_name="ShirAtashNeshani"
    elif [[ "$glb_basename" == *"fire-extinguisher"* ]] || [[ "$glb_basename" == *"extinguisher"* ]] || [[ "$glb_basename" == *"Kapsole"* ]]; then
        class_name="KapsoleAtashNeshani"
    elif [[ "$glb_basename" == *"Panel"* ]] || [[ "$glb_basename" == *"box"* ]] || [[ "$glb_basename" == *"ELBox"* ]] || [[ "$glb_basename" == *"Skrzynka"* ]]; then
        class_name="PanelBargh"
    else
        echo "⚠️ Could not determine class for: $glb_basename"
        echo "   Skipping..."
        echo ""
        continue
    fi
    
    echo "🏷️ Class: $class_name"
    
    # پیدا کردن پوشه کلاس در public/models
    class_dir="public/models/$class_name"
    if [ ! -d "$class_dir" ]; then
        echo "❌ Class directory not found: $class_dir"
        echo ""
        continue
    fi
    
    echo "📁 Class dir: $class_dir"
    
    # پیدا کردن فایل اصلی مدل در پوشه کلاس
    # با استفاده از بخش‌های اسم GLB
    original_file=""
    
    # روش 1: جستجوی مستقیم با بخش‌های اسم
    # حذف پیشوندها و پسوندها
    search_name=$(echo "$glb_basename" | sed -E 's/^(Crane_|Compressor_|compressor_|electric-motor_|FireTruck_|fire_hydrant_|fire-extinguisher_|electric_box_|fan_|Hydrant_|Panel_|ElectroMotor_|FanSanati_|Kapsole_|ShirAtash_|models_|Crane_|electric_box_|fire-extinguisher_|fire_hydrant_|Crane_|compressor_|electric_box_|fan_)//' | sed -E 's/_(Crane|Compressor|ElectroMotor|FanSanati|FireTruck|Hydrant|PanelBargh|ShirAtashNeshani|KapsoleAtashNeshani)$//' | sed -E 's/^[0-9]+_//')
    
    # حذف کاراکترهای خاص برای جستجو
    search_name_clean=$(echo "$search_name" | sed 's/[()]//g' | sed 's/ /_/g' | sed 's/__/_/g')
    
    echo "🔍 Search name: $search_name_clean"
    
    # جستجو در پوشه کلاس
    original_file=$(find "$class_dir" -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.glb" -o -name "*.gltf" \) | grep -i "$search_name_clean" | head -1)
    
    # اگر پیدا نشد، با روش دوم جستجو کن
    if [ -z "$original_file" ]; then
        # جستجوی با اسم اصلی (بدون شماره)
        base_name=$(echo "$glb_basename" | sed -E 's/^[0-9]+_//' | sed -E 's/_[0-9]+$//' | sed -E 's/_[a-z]+$//')
        echo "🔍 Second search (base name): $base_name"
        original_file=$(find "$class_dir" -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.glb" -o -name "*.gltf" \) | grep -i "$base_name" | head -1)
    fi
    
    # اگر باز هم پیدا نشد، همه فایل‌های پوشه رو بررسی کن
    if [ -z "$original_file" ]; then
        echo "🔍 Third search: all files in $class_dir"
        # لیست همه فایل‌های مدل در پوشه
        all_files=$(find "$class_dir" -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.glb" -o -name "*.gltf" \))
        if [ -n "$all_files" ]; then
            # اولین فایل رو انتخاب کن
            original_file=$(echo "$all_files" | head -1)
            echo "   Selected: $(basename "$original_file")"
        fi
    fi
    
    if [ -z "$original_file" ]; then
        echo "❌ No original model file found in $class_dir"
        echo ""
        continue
    fi
    
    echo "📄 Original file: $original_file"
    
    # ساخت مسیر هدف
    target_dir=$(dirname "$original_file")
    target_name=$(basename "$original_file" | sed 's/\.[^.]*$/.glb/')
    target_path="$target_dir/$target_name"
    
    echo "📤 Target: $target_path"
    
    # کپی فایل GLB به جای فایل اصلی
    cp "$glb_file" "$target_path"
    
    # حذف فایل اصلی
    echo "🗑️ Removing original: $original_file"
    rm "$original_file"
    
    # حذف فایل‌های MTL و تکسچرهای اضافی در همان پوشه
    echo "🗑️ Cleaning texture files..."
    find "$target_dir" -name "*.mtl" -delete 2>/dev/null
    find "$target_dir" -name "*.png" -delete 2>/dev/null
    find "$target_dir" -name "*.jpg" -delete 2>/dev/null
    find "$target_dir" -name "*.jpeg" -delete 2>/dev/null
    find "$target_dir" -name "*.tga" -delete 2>/dev/null
    find "$target_dir" -name "*.webp" -delete 2>/dev/null
    
    echo "✅ Done!"
    echo ""
done

echo "=========================================="
echo "ALL COMPLETE!"
echo "=========================================="